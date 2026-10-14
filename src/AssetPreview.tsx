import type { VRM } from "@pixiv/three-vrm";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  AmbientLight,
  AnimationMixer,
  Box3,
  Color,
  DirectionalLight,
  Group,
  Mesh,
  LoadingManager,
  ACESFilmicToneMapping,
  NoToneMapping,
  PerspectiveCamera,
  Scene,
  Texture,
  Vector3,
  WebGLRenderer,
  type Material,
  type Object3D,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  GLTFLoader,
  type GLTF,
} from "three/examples/jsm/loaders/GLTFLoader.js";
import { normalizeAvatarBounds } from "./normalization";
import {
  measureAvatarSpatialBounds,
  type AvatarSpatialBounds,
} from "./bounds";
import {
  DEFAULT_AVATAR_PREVIEW_FOV,
  fitAvatarPreviewCamera,
  resolveAvatarPreviewTargetHeight,
} from "./previewFraming";
import {
  configureAvatarGltfLoader,
  configureAvatarVrmLoader,
  detectVrmKind,
  disposeVrm,
} from "./vrm";
import { getSharedAvatarClips } from "./sharedAnimations";

export type AssetPreviewProps = {
  kind?: "avatar" | "item";
  lighting?: PreviewLighting;
  shading?: PreviewShading;
  exposure?: number;
  toneMapping?: "none" | "aces";
  variants?: readonly PreviewVariant[];
  variant?: string;
  integrity?: PreviewIntegrity;
  maxBytes?: number;
  /** Restrict parsing to a self-contained GLB; no external model resources. */
  embeddedOnly?: boolean;
  onStateChange?: (state: "loading" | "ready" | "failed") => void;
  url: string;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
  background?: string;
  autoRotate?: boolean;
  /** Play the shared idle fallback when a VRM has no embedded clips. */
  sharedAnimations?: boolean;
  /** Let shared clips drive hips translation. Off keeps previews in place. */
  sharedHipsPosition?: boolean;
  fallback?: ReactNode;
};

import { downloadPreview, DEFAULT_PREVIEW_MAX_BYTES, type PreviewIntegrity } from "./previewDownload";
import { bindPreviewVariants, createPreviewShading, PREVIEW_LIGHTING_PRESETS,
  type PreviewLighting, type PreviewShading, type PreviewVariant } from "./previewSettings";

function defaultFallback(label: string) {
  return (
    <div role="img" aria-label={label} style={{ padding: "1rem" }}>
      3D preview unavailable
    </div>
  );
}

function disposeMaterial(material: Material) {
  for (const value of Object.values(material)) {
    if (value instanceof Texture) value.dispose();
  }
  material.dispose();
}

function disposeObject(root: Object3D) {
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.geometry?.dispose();
    const materials = Array.isArray(object.material)
      ? object.material
      : [object.material];
    materials.forEach(disposeMaterial);
  });
}

function configureSrgbOutput(renderer: WebGLRenderer) {
  const compatibleRenderer = renderer as unknown as {
    outputColorSpace?: string;
    outputEncoding?: number;
  };
  if (typeof compatibleRenderer.outputColorSpace === "string") {
    compatibleRenderer.outputColorSpace = "srgb";
  } else {
    // THREE.sRGBEncoding in r139. Avoid importing a symbol removed in r152.
    compatibleRenderer.outputEncoding = 3001;
  }
}

type LoadedPreviewGltf = {
  gltf: GLTF;
  vrm: VRM | null;
  enhancementError?: unknown;
};

function gltfVrm(gltf: GLTF): VRM | null {
  return (gltf.userData.vrm as VRM | undefined) ?? null;
}

/**
 * Parse the common path exactly once with the VRM plugin. A malformed VRM
 * extension gets one plain-glTF retry so its geometry and clips remain usable.
 */
async function loadPreviewGltf(url: string, signal: AbortSignal, maxBytes: number,
  integrity: PreviewIntegrity | undefined, embeddedOnly: boolean): Promise<LoadedPreviewGltf> {
  const bytes = await downloadPreview(url, signal, maxBytes, integrity);
  const manager = new LoadingManager();
  if (embeddedOnly) manager.setURLModifier((resource) => {
    if (!resource.startsWith("blob:") && !resource.startsWith("data:"))
      throw new Error("External model resources are blocked");
    return resource;
  });
  const path = embeddedOnly ? "" : new URL(".", new URL(url, window.location.href)).href;
  try {
    const gltf = await configureAvatarVrmLoader(new GLTFLoader(manager)).parseAsync(bytes, path);
    return { gltf, vrm: gltfVrm(gltf) };
  } catch (enhancementError) {
    signal.throwIfAborted();
    const gltf = await configureAvatarGltfLoader(new GLTFLoader(manager)).parseAsync(bytes, path);
    return { gltf, vrm: null, enhancementError };
  }
}

function disposeLoadedGltf(gltf: GLTF, vrm: VRM | null) {
  if (vrm) disposeVrm(vrm);
  else disposeObject(gltf.scene);
}

function boxFromSpatialBounds(bounds: AvatarSpatialBounds): Box3 {
  return new Box3(
    new Vector3(bounds.minX, bounds.minY, bounds.minZ),
    new Vector3(bounds.maxX, bounds.maxY, bounds.maxZ)
  );
}

function spatialBoundsFromBox(bounds: Box3): AvatarSpatialBounds {
  return {
    minX: bounds.min.x,
    maxX: bounds.max.x,
    minY: bounds.min.y,
    maxY: bounds.max.y,
    minZ: bounds.min.z,
    maxZ: bounds.max.z,
  };
}

/**
 * Self-contained Three.js preview for non-R3F apps such as Arena.
 * It shares the Space VRM detection, Draco loader and height normalization,
 * while owning its canvas lifecycle so React 18/19 reconcilers never mix.
 */
export function AssetPreview({
  kind = "item",
  lighting = PREVIEW_LIGHTING_PRESETS.studio,
  shading = "original",
  exposure = 1,
  toneMapping = kind === "avatar" ? "none" : "aces",
  variants, variant, integrity,
  maxBytes = DEFAULT_PREVIEW_MAX_BYTES,
  embeddedOnly = false,
  onStateChange,
  url,
  className,
  style,
  ariaLabel = "3D model preview",
  background = "transparent",
  autoRotate = true,
  sharedAnimations = true,
  sharedHipsPosition = false,
  fallback = defaultFallback(ariaLabel),
}: AssetPreviewProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  const settings = useRef({ lighting, shading, exposure, autoRotate, variant, toneMapping });
  settings.current = { lighting, shading, exposure, autoRotate, variant, toneMapping };
  const callback = useRef(onStateChange);
  callback.current = onStateChange;
  const runtime = useRef<(() => void) | null>(null);
  useEffect(() => { runtime.current?.(); }, [lighting, shading, exposure, autoRotate, variant, toneMapping]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !url) return;

    const controller = new AbortController();
    let cancelled = false;
    let materials: ReturnType<typeof createPreviewShading> | null = null;
    let selectVariant: ((id: string) => void) | null = null;
    let activeVariant: string | undefined;
    let runtimeDisposed = false;
    let renderLoopActive = true;
    let frame = 0;
    let model: Object3D | null = null;
    let modelRoot: Group | null = null;
    let vrm: VRM | null = null;
    let mixer: AnimationMixer | null = null;
    let previewBounds: AvatarSpatialBounds | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let usingWindowResize = false;
    setReady(false);
    setFailed(false);
    callback.current?.("loading");

    const scene = new Scene();
    const camera = new PerspectiveCamera(
      DEFAULT_AVATAR_PREVIEW_FOV,
      1,
      0.01,
      100
    );
    camera.position.set(0, 0.8, 2.4);
    camera.lookAt(0, 0.6, 0);

    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({
        alpha: background === "transparent",
        antialias: true,
      });
    } catch (error) {
      console.warn("[avatar-renderer] WebGL initialization failed", error);
      setFailed(true);
      callback.current?.("failed");
      return;
    }
    configureSrgbOutput(renderer);

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    if (background === "transparent") {
      renderer.setClearColor(0x000000, 0);
    } else {
      renderer.setClearColor(new Color(background), 1);
    }
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    mount.appendChild(renderer.domElement);

    const ambientLight = new AmbientLight(0xffffff, 0.9);
    scene.add(ambientLight);
    const keyLight = new DirectionalLight(0xffffff, 1.25);
    keyLight.position.set(2, 3, 3);
    scene.add(keyLight);
    const fillLight = new DirectionalLight(0xffffff, 0.45);
    fillLight.position.set(-2, 1, -2);
    scene.add(fillLight);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false;
    controls.enableZoom = true;
    controls.minDistance = 1.4;
    controls.maxDistance = 4;
    controls.target.set(0, 0.65, 0);
    controls.autoRotate = settings.current.autoRotate;
    controls.autoRotateSpeed = 0.8;
    if (kind === "item") camera.position.set(2, 1.4, 2.4);
    controls.update();

    const frameCamera = () => {
      if (!previewBounds) return;
      const fitted = fitAvatarPreviewCamera({
        bounds: previewBounds,
        aspect: camera.aspect,
        verticalFovDegrees: camera.fov,
      });
      const direction = camera.position.clone().sub(controls.target);
      if (direction.lengthSq() < 1e-8) direction.set(0, 0.06, 1);
      direction.normalize();

      controls.target.set(
        fitted.target.x,
        fitted.target.y,
        fitted.target.z
      );
      controls.minDistance = fitted.minDistance;
      controls.maxDistance = fitted.maxDistance;
      camera.near = fitted.near;
      camera.far = fitted.far;
      camera.position
        .copy(controls.target)
        .addScaledVector(direction, fitted.distance);
      camera.updateProjectionMatrix();
      controls.update();
    };

    const resize = () => {
      const width = Math.max(1, mount.clientWidth);
      const height = Math.max(1, mount.clientHeight);
      camera.aspect = width / height;
      renderer.setSize(width, height, false);
      if (previewBounds) frameCamera();
      else camera.updateProjectionMatrix();
    };
    resize();
    resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    resizeObserver?.observe(mount);
    if (!resizeObserver) {
      usingWindowResize = true;
      window.addEventListener("resize", resize);
    }

    const stopRenderLoop = () => {
      renderLoopActive = false;
      if (frame !== 0) window.cancelAnimationFrame(frame);
      frame = 0;
    };

    const disposeRuntime = () => {
      if (runtimeDisposed) return;
      runtimeDisposed = true;
      stopRenderLoop();
      resizeObserver?.disconnect();
      if (usingWindowResize) window.removeEventListener("resize", resize);
      controls.dispose();
      mixer?.stopAllAction();
      if (model && mixer) mixer.uncacheRoot(model);
      if (modelRoot) scene.remove(modelRoot);
      materials?.dispose();
      materials = null;
      runtime.current = null;
      if (vrm) disposeVrm(vrm);
      else if (model) disposeObject(model);
      vrm = null;
      model = null;
      modelRoot = null;
      previewBounds = null;
      renderer.domElement.removeEventListener("webglcontextlost", contextLost);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };

    const contextLost = (event: Event) => {
      event.preventDefault();
      setFailed(true);
      setReady(false);
      callback.current?.("failed");
      controller.abort();
      disposeRuntime();
    };
    renderer.domElement.addEventListener("webglcontextlost", contextLost);

    const updateSettings = () => {
      const current = settings.current;
      for (const [light, config] of [[ambientLight, current.lighting.ambient],
        [keyLight, current.lighting.key], [fillLight, current.lighting.fill]] as const) {
        light.color.set(config.color);
        light.intensity = Number.isFinite(config.intensity) ? Math.max(0, Math.min(20, config.intensity)) : 1;
      }
      keyLight.position.set(...current.lighting.key.position);
      fillLight.position.set(...current.lighting.fill.position);
      renderer.toneMapping = current.toneMapping === "aces" ? ACESFilmicToneMapping : NoToneMapping;
      renderer.toneMappingExposure = Number.isFinite(current.exposure) ? Math.max(0.1, Math.min(4, current.exposure)) : 1;
      controls.autoRotate = current.autoRotate;
      materials?.apply(current.shading);
      if (selectVariant && model && current.variant && current.variant !== activeVariant) {
        selectVariant(current.variant);
        activeVariant = current.variant;
        previewBounds = measureAvatarSpatialBounds(model);
        frameCamera();
      }
    };
    runtime.current = updateSettings;
    updateSettings();
    let previousTime = performance.now();
    const renderFrame = (time: number) => {
      if (!renderLoopActive || runtimeDisposed) return;
      const delta = Math.min((time - previousTime) / 1000, 0.1);
      previousTime = time;
      if (document.hidden) { frame = window.requestAnimationFrame(renderFrame); return; }
      mixer?.update(delta);
      vrm?.update(delta);
      controls.update();
      renderer.render(scene, camera);
      frame = window.requestAnimationFrame(renderFrame);
    };
    frame = window.requestAnimationFrame(renderFrame);

    const loadTimeout = window.setTimeout(() => controller.abort(), 30_000);
    loadPreviewGltf(url, controller.signal, maxBytes, integrity, embeddedOnly)
      .then(async ({ gltf, vrm: loadedVrm, enhancementError }) => {
        window.clearTimeout(loadTimeout);
        if (cancelled || runtimeDisposed) {
          disposeLoadedGltf(gltf, loadedVrm);
          return;
        }

        if (enhancementError) {
          console.warn(
            "[avatar-renderer] preview VRM enhancement failed; using base glTF",
            url,
            enhancementError
          );
        }
        const vrmKind = detectVrmKind(gltf.parser?.json);
        let animations = gltf.animations;
        let usingSharedAnimations = false;
        if (
          animations.length === 0 &&
          loadedVrm &&
          sharedAnimations && kind === "avatar"
        ) {
          try {
            animations = await getSharedAvatarClips({
              vrm: loadedVrm,
              vrmKind,
              hipsPosition: sharedHipsPosition,
            });
            usingSharedAnimations = animations.length > 0;
          } catch (error) {
            console.warn(
              "[avatar-renderer] preview shared animations failed to load",
              url,
              error
            );
          }
        }

        // The effect may have been replaced while the lazy animation chunk
        // was loading. The pending glTF is still owned here, not by runtime.
        if (cancelled || runtimeDisposed) {
          disposeLoadedGltf(gltf, loadedVrm);
          return;
        }

        vrm = loadedVrm;
        model = vrm?.scene ?? gltf.scene;
        if (usingSharedAnimations && vrm) {
          vrm.humanoid.autoUpdateHumanBones = true;
        }

        if (kind === "avatar" && animations.length > 0) {
          mixer = new AnimationMixer(model);
          const idle =
            animations.find(
              (clip) => clip.name.trim().toLowerCase() === "idle"
            ) ?? animations[0];
          mixer.clipAction(idle).play();
          // Apply the first visible pose before deriving bounds. Otherwise a
          // wide rigging T-pose can make an ordinary idle avatar look tiny.
          mixer.update(0);
          vrm?.update(0);
        }

        if (variants?.length) {
          selectVariant = bindPreviewVariants(model, gltf.parser.associations, gltf.parser.json.nodes ?? [], variants);
          activeVariant = settings.current.variant ?? variants[0].id;
          selectVariant(activeVariant);
        }
        materials = createPreviewShading(model);
        const bounds = measureAvatarSpatialBounds(model);
        const normalization = normalizeAvatarBounds({
          minY: bounds.minY,
          maxY: bounds.maxY,
          targetHeight: resolveAvatarPreviewTargetHeight(gltf.parser?.json),
        });
        modelRoot = new Group();
        modelRoot.rotation.y = kind === "avatar" && vrmKind === "vrm0" ? Math.PI : 0;
        if (kind === "avatar") {
          modelRoot.scale.setScalar(normalization.scale);
          modelRoot.position.y = normalization.positionY;
        } else {
          const longest = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ, 0.001);
          modelRoot.scale.setScalar(2 / longest);
        }
        modelRoot.add(model);
        modelRoot.updateMatrix();
        previewBounds = spatialBoundsFromBox(
          boxFromSpatialBounds(bounds).applyMatrix4(modelRoot.matrix)
        );
        scene.add(modelRoot);
        frameCamera();
        updateSettings();
        setReady(true);
        callback.current?.("ready");
      })
      .catch((error) => {
        window.clearTimeout(loadTimeout);
        if (cancelled || runtimeDisposed) return;
        console.warn("[avatar-renderer] preview failed", url, error);
        setFailed(true);
        callback.current?.("failed");
        cancelled = true;
        disposeRuntime();
      });

    return () => {
      cancelled = true;
      window.clearTimeout(loadTimeout);
      controller.abort();
      disposeRuntime();
    };
  }, [
    kind,
    variants,
    integrity?.sha256,
    integrity?.sizeBytes,
    embeddedOnly,
    maxBytes,
    background,
    sharedAnimations,
    sharedHipsPosition,
    url,
  ]);

  if (!url) return <>{fallback}</>;

  return (
    <div
      className={className}
      role="img"
      aria-label={ariaLabel}
      data-asset-render-state={failed ? "failed" : ready ? "ready" : "loading"}
      data-avatar-render-state={failed ? "failed" : ready ? "ready" : "loading"}
      style={{ minHeight: 220, position: "relative", width: "100%", ...style }}
    >
      <div ref={mountRef} style={{ position: "absolute", inset: 0 }} />
      {!ready ? (
        <div style={{ position: "absolute", inset: 0 }}>{fallback}</div>
      ) : null}
    </div>
  );
}
