import { useFrame, useLoader } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { AnimationMixer, type Object3D } from "three";
import {
  GLTFLoader,
  type GLTF,
} from "three/examples/jsm/loaders/GLTFLoader.js";
import * as SkeletonUtilsRuntime from "three/examples/jsm/utils/SkeletonUtils.js";
import {
  configureAvatarGltfLoader,
  detectVrmKind,
  useVrmEnhancement,
} from "./vrm";
import {
  normalizeAvatarBounds,
  readEmbeddedAvatarHeightScale,
} from "./normalization";
import { measureAvatarBounds } from "./bounds";

// @types/three@0.137 declared a namespace while the matching runtime already
// exported named functions. Keep the compatibility cast local to this seam.
const cloneSkeleton = (
  SkeletonUtilsRuntime as unknown as { clone(source: Object3D): Object3D }
).clone;

export type AvatarAnimationState = "idle" | "walk";

export type AvatarModelProps = {
  url: string;
  rotationY?: number;
  /** Instance-level scale applied after height normalization. */
  avatarScale?: number;
  /** Stable model-specific multiplier; glTF extras are used when omitted. */
  avatarHeightScale?: number;
  groundOffset?: number;
  animState?: AvatarAnimationState;
  targetHeight?: number;
  castShadow?: boolean;
};

/**
 * Render one independent GLB/VRM avatar inside an existing R3F Canvas.
 * Space owns movement/physics; this component owns only model loading,
 * normalization, orientation and embedded idle/walk animations.
 */
export function AvatarModel({
  url,
  rotationY = 0,
  avatarScale = 1,
  avatarHeightScale,
  groundOffset = 0,
  animState = "idle",
  targetHeight = 1,
  castShadow = true,
}: AvatarModelProps) {
  const original = useLoader(
    GLTFLoader,
    url,
    (loader) => configureAvatarGltfLoader(loader as GLTFLoader)
  ) as GLTF & {
    parser?: { json?: Parameters<typeof detectVrmKind>[0] };
  };
  const vrmKind = useMemo(
    () => detectVrmKind(original.parser?.json),
    [original.parser?.json]
  );
  const embeddedHeightScale = useMemo(
    () => readEmbeddedAvatarHeightScale(original.parser?.json),
    [original.parser?.json]
  );
  const resolvedHeightScale = avatarHeightScale ?? embeddedHeightScale;
  const clonedScene = useMemo(
    () => cloneSkeleton(original.scene),
    [original.scene]
  );
  const vrm = useVrmEnhancement(url, vrmKind);
  const model = vrm?.scene ?? clonedScene;
  const facingCorrection = vrmKind === "vrm0" ? Math.PI : 0;
  const mixer = useMemo(() => new AnimationMixer(model), [model]);
  const actions = useMemo(
    () =>
      Object.fromEntries(
        original.animations.map((clip) => [clip.name, mixer.clipAction(clip)])
      ),
    [mixer, original.animations]
  );

  useEffect(
    () => () => {
      mixer.stopAllAction();
      mixer.uncacheRoot(model);
    },
    [mixer, model]
  );

  useEffect(() => {
    model.traverse((object: Object3D) => {
      if (castShadow) object.castShadow = true;
      object.frustumCulled = false;
    });
  }, [castShadow, model]);

  // Measure the unscaled rendered scene once. Static geometry bounds ignore
  // skinning and include all morph-target extremes; both are common in VRM.
  // The outer group below remains the sole owner of normalization transforms.
  const sourceBounds = useMemo(() => measureAvatarBounds(model), [model]);

  const normalization = useMemo(() => {
    return normalizeAvatarBounds({
      minY: sourceBounds.minY,
      maxY: sourceBounds.maxY,
      targetHeight: targetHeight * resolvedHeightScale,
      avatarScale,
      groundOffset,
    });
  }, [
    avatarScale,
    groundOffset,
    resolvedHeightScale,
    sourceBounds,
    targetHeight,
  ]);

  useEffect(() => {
    actions.idle?.play();
  }, [actions.idle]);

  useEffect(() => {
    if (!actions.idle || !actions.walk) return;
    if (animState === "walk") {
      actions.idle.fadeOut(0.2);
      actions.walk.reset().fadeIn(0.2).play();
    } else {
      actions.walk.fadeOut(0.2);
      actions.idle.reset().fadeIn(0.2).play();
    }
  }, [actions.idle, actions.walk, animState]);

  useFrame((_, delta) => {
    mixer.update(delta);
    vrm?.update(delta);
  });

  return (
    <group
      rotation={[0, rotationY + facingCorrection, 0]}
      scale={normalization.scale}
      position={[0, normalization.positionY, 0]}
    >
      <primitive object={model} />
    </group>
  );
}
