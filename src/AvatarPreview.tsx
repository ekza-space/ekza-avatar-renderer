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
  Color,
  DirectionalLight,
  Group,
  Mesh,
  PerspectiveCamera,
  Scene,
  Texture,
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
import { measureAvatarBounds } from "./bounds";
import {
  buildVrmInstance,
  configureAvatarGltfLoader,
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
    let frame = 0;
    let model: Object3D | null = null;
    let modelRoot: Group | null = null;
    let vrm: VRM | null = null;
    let mixer: AnimationMixer | null = null;
    setReady(false);
    setFailed(false);

    const scene = new Scene();
    const camera = new PerspectiveCamera(32, 1, 0.01, 100);
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

    const resize = () => {
      const width = Math.max(1, mount.clientWidth);
      const height = Math.max(1, mount.clientHeight);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };
    resize();
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    resizeObserver?.observe(mount);
    if (!resizeObserver) window.addEventListener("resize", resize);

    let previousTime = performance.now();
    const renderFrame = (time: number) => {
      const delta = Math.min((time - previousTime) / 1000, 0.1);
      previousTime = time;
      mixer?.update(delta);
      vrm?.update(delta);
      controls.update();
      renderer.render(scene, camera);
      frame = window.requestAnimationFrame(renderFrame);
    };
    frame = window.requestAnimationFrame(renderFrame);

    const loader = configureAvatarGltfLoader(new GLTFLoader());
    loader
      .loadAsync(url)
      .then(async (gltf: GLTF) => {
        if (cancelled) {
          disposeObject(gltf.scene);
          return;
        }

        const vrmKind = detectVrmKind(gltf.parser?.json);
        if (vrmKind !== "none") {
          try {
            vrm = await buildVrmInstance(url);
          } catch (error) {
            console.warn(
              "[avatar-renderer] preview VRM enhancement failed; using base glTF",
              url,
              error
            );
          }
        }
        if (cancelled) {
          if (vrm) disposeVrm(vrm);
          disposeObject(gltf.scene);
          return;
        }

        model = vrm?.scene ?? gltf.scene;
        if (vrm) disposeObject(gltf.scene);
        const bounds = measureAvatarBounds(model);
        const normalization = normalizeAvatarBounds({
          minY: bounds.minY,
          maxY: bounds.maxY,
          avatarScale: 1.45,
        });
        modelRoot = new Group();
        modelRoot.rotation.y = vrmKind === "vrm0" ? Math.PI : 0;
        modelRoot.scale.setScalar(normalization.scale);
        modelRoot.position.y = normalization.positionY;
        modelRoot.add(model);
        scene.add(modelRoot);

        if (gltf.animations.length > 0) {
          mixer = new AnimationMixer(model);
          const idle =
            gltf.animations.find(
              (clip) => clip.name.trim().toLowerCase() === "idle"
            ) ?? gltf.animations[0];
          mixer.clipAction(idle).play();
        }
        setReady(true);
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn("[avatar-renderer] preview failed", url, error);
        setFailed(true);
      });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      if (!resizeObserver) window.removeEventListener("resize", resize);
      controls.dispose();
      mixer?.stopAllAction();
      if (modelRoot) scene.remove(modelRoot);
      if (vrm) disposeVrm(vrm);
      else if (model) disposeObject(model);
      renderer.dispose();
      renderer.domElement.remove();
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
