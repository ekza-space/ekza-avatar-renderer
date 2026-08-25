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

export type AvatarPreviewProps = {
  url: string;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
  background?: string;
  autoRotate?: boolean;
  fallback?: ReactNode;
};

function defaultFallback(label: string) {
  return (
    <div role="img" aria-label={label} style={{ padding: "1rem" }}>
      3D avatar unavailable
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
async function loadPreviewGltf(url: string): Promise<LoadedPreviewGltf> {
  try {
    const gltf = await configureAvatarVrmLoader(
      new GLTFLoader()
    ).loadAsync(url);
    return { gltf, vrm: gltfVrm(gltf) };
  } catch (enhancementError) {
    const gltf = await configureAvatarGltfLoader(
      new GLTFLoader()
    ).loadAsync(url);
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
export function AvatarPreview({
  url,
  className,
  style,
  ariaLabel = "3D avatar preview",
  background = "transparent",
  autoRotate = true,
  fallback = defaultFallback(ariaLabel),
}: AvatarPreviewProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !url) return;

    let cancelled = false;
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

    scene.add(new AmbientLight(0xffffff, 0.9));
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
    controls.autoRotate = autoRotate;
    controls.autoRotateSpeed = 0.8;
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
      if (vrm) disposeVrm(vrm);
      else if (model) disposeObject(model);
      vrm = null;
      model = null;
      modelRoot = null;
      previewBounds = null;
      renderer.dispose();
      renderer.domElement.remove();
    };

    let previousTime = performance.now();
    const renderFrame = (time: number) => {
      if (!renderLoopActive || runtimeDisposed) return;
      const delta = Math.min((time - previousTime) / 1000, 0.1);
      previousTime = time;
      mixer?.update(delta);
      vrm?.update(delta);
      controls.update();
      renderer.render(scene, camera);
      frame = window.requestAnimationFrame(renderFrame);
    };
    frame = window.requestAnimationFrame(renderFrame);

    loadPreviewGltf(url)
      .then(({ gltf, vrm: loadedVrm, enhancementError }) => {
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
        vrm = loadedVrm;
        model = vrm?.scene ?? gltf.scene;

        if (gltf.animations.length > 0) {
          mixer = new AnimationMixer(model);
          const idle =
            gltf.animations.find(
              (clip) => clip.name.trim().toLowerCase() === "idle"
            ) ?? gltf.animations[0];
          mixer.clipAction(idle).play();
          // Apply the first visible pose before deriving bounds. Otherwise a
          // wide rigging T-pose can make an ordinary idle avatar look tiny.
          mixer.update(0);
          vrm?.update(0);
        }

        const bounds = measureAvatarSpatialBounds(model);
        const normalization = normalizeAvatarBounds({
          minY: bounds.minY,
          maxY: bounds.maxY,
          targetHeight: resolveAvatarPreviewTargetHeight(gltf.parser?.json),
        });
        modelRoot = new Group();
        modelRoot.rotation.y = vrmKind === "vrm0" ? Math.PI : 0;
        modelRoot.scale.setScalar(normalization.scale);
        modelRoot.position.y = normalization.positionY;
        modelRoot.add(model);
        modelRoot.updateMatrix();
        previewBounds = spatialBoundsFromBox(
          boxFromSpatialBounds(bounds).applyMatrix4(modelRoot.matrix)
        );
        scene.add(modelRoot);
        frameCamera();
        setReady(true);
      })
      .catch((error) => {
        if (cancelled || runtimeDisposed) return;
        console.warn("[avatar-renderer] preview failed", url, error);
        setFailed(true);
        cancelled = true;
        disposeRuntime();
      });

    return () => {
      cancelled = true;
      disposeRuntime();
    };
  }, [autoRotate, background, url]);

  if (!url) return <>{fallback}</>;

  return (
    <div
      className={className}
      role="img"
      aria-label={ariaLabel}
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
