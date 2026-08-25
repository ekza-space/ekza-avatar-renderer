import { useFrame, useLoader } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  AnimationMixer,
  type AnimationAction,
  type Object3D,
} from "three";
import {
  GLTFLoader,
  type GLTF,
} from "three/examples/jsm/loaders/GLTFLoader.js";
import * as SkeletonUtilsRuntime from "three/examples/jsm/utils/SkeletonUtils.js";
import {
  configureAvatarGltfLoader,
  detectVrmKind,
  useVrmAsset,
} from "./vrm";
import {
  normalizeAvatarBounds,
  readEmbeddedAvatarHeightScale,
} from "./normalization";
import { measureAvatarBounds } from "./bounds";
import { mergeAvatarClips, useSharedAvatarClips } from "./sharedAnimations";

// @types/three@0.137 declared a namespace while the matching runtime already
// exported named functions. Keep the compatibility cast local to this seam.
const cloneSkeleton = (
  SkeletonUtilsRuntime as unknown as { clone(source: Object3D): Object3D }
).clone;

/** Apply render flags to every object, including turning shadows back off. */
export function configureAvatarModelScene(
  model: Object3D,
  castShadow: boolean
): void {
  model.traverse((object: Object3D) => {
    object.castShadow = castShadow;
    object.frustumCulled = false;
  });
}

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
  /** Exact embedded clip name. `tpose` stops all clips. */
  animation?: string;
  /** Reports available clip names so host UIs can offer an animation picker. */
  onAnimationsChange?: (animations: string[]) => void;
  /**
   * Fall back to the bundled humanoid clip library when a VRM ships no
   * animations of its own. Embedded clips always win, and the library is not
   * even fetched while any are present.
   */
  sharedAnimations?: boolean;
  /** Let the shared clips drive hips translation. Off keeps locomotion in place. */
  sharedHipsPosition?: boolean;
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
  animation,
  onAnimationsChange,
  sharedAnimations = true,
  sharedHipsPosition = true,
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
  const vrmAsset = useVrmAsset(url, vrmKind);
  const vrm = vrmAsset?.vrm ?? null;
  const model = vrm?.scene ?? clonedScene;
  // VRM clips target the nodes of their own fresh parse. Mixing clips from the
  // cached base glTF with the fresh VRM scene silently breaks bone animation.
  const embedded = vrmAsset?.animations ?? original.animations;
  const facingCorrection = vrmKind === "vrm0" ? Math.PI : 0;
  const mixer = useMemo(() => new AnimationMixer(model), [model]);
  const sharedClips = useSharedAvatarClips({
    vrm,
    vrmKind,
    // Retargeting is a fallback, never an override: the library is not fetched
    // at all while the file brings clips of its own.
    enabled: sharedAnimations && embedded.length === 0,
    hipsPosition: sharedHipsPosition,
  });
  const animations = useMemo(
    () => mergeAvatarClips(embedded, sharedClips),
    [embedded, sharedClips]
  );
  const actions = useMemo(
    () =>
      Object.fromEntries(
        animations.map((clip) => [clip.name, mixer.clipAction(clip)])
      ),
    [animations, mixer]
  );
  const previousAction = useRef<AnimationAction | null>(null);

  const activeAction = useMemo(() => {
    const requested = animation?.trim();
    if (requested?.toLowerCase() === "tpose") return null;

    const requestedName = requested || animState;
    const exact = actions[requestedName];
    if (exact) return exact;

    const normalizedName = requestedName.toLowerCase();
    return (
      Object.entries(actions).find(
        ([name]) => name.trim().toLowerCase() === normalizedName
      )?.[1] ?? null
    );
  }, [actions, animState, animation]);

  useEffect(
    () => () => {
      mixer.stopAllAction();
      mixer.uncacheRoot(model);
      previousAction.current = null;
    },
    [mixer, model]
  );

  useEffect(() => {
    configureAvatarModelScene(model, castShadow);
  }, [castShadow, model]);

  useEffect(() => {
    onAnimationsChange?.(animations.map((clip) => clip.name));
  }, [animations, onAnimationsChange]);

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
    const previous = previousAction.current;
    if (previous === activeAction) {
      activeAction?.play();
      return;
    }

    previous?.fadeOut(0.2);
    if (activeAction) activeAction.reset().fadeIn(0.2).play();
    else mixer.stopAllAction();
    previousAction.current = activeAction;
  }, [activeAction, mixer]);

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
