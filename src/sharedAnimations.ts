import { useEffect, useState } from "react";
import type { AnimationClip } from "three";
import type { VRM } from "@pixiv/three-vrm";
import {
  retargetHumanoidClips,
  type RetargetOptions,
  type SerializedHumanoidClip,
} from "./humanoidRetarget";
import type { VrmKind } from "./vrm";

const EMPTY_CLIPS: AnimationClip[] = [];

let libraryPromise: Promise<readonly SerializedHumanoidClip[]> | null = null;

/**
 * Load the baked humanoid clip library once per page.
 *
 * The data lives in its own module so bundlers emit it as a separate chunk:
 * avatars that ship their own clips never pay for it. Shipping it as JS rather
 * than as a `.glb` next to `dist/` is deliberate — the package is installed as
 * a git dependency and built through `prepare`, so consumers have no place to
 * serve an extra binary from and no bundler rule to import one.
 */
export function loadSharedHumanoidClips(): Promise<
  readonly SerializedHumanoidClip[]
> {
  if (!libraryPromise) {
    libraryPromise = import("./sharedAnimationData")
      .then((module) => module.SHARED_HUMANOID_CLIPS)
      .catch((error) => {
        libraryPromise = null;
        throw error;
      });
  }
  return libraryPromise;
}

/**
 * Retargeted clips are bound to one VRM's normalized bone nodes, so they can
 * only be shared between renders of the same model — not between instances.
 * Keyed by retarget options as well, because those change the baked values.
 */
const clipCache = new WeakMap<object, Map<string, AnimationClip[]>>();

type SharedAvatarClipsState = {
  humanoid: object | null;
  cacheKey: string;
  clips: AnimationClip[];
};

export type SharedAvatarClipsArgs = {
  vrm: VRM | null;
  vrmKind?: VrmKind;
  enabled?: boolean;
} & Pick<RetargetOptions, "hipsPosition">;

function sharedAvatarClipCacheKey(
  vrmKind: VrmKind,
  hipsPosition: boolean
): string {
  return `${vrmKind === "vrm0"}:${hipsPosition}`;
}

/**
 * Resolve shared clips for one concrete VRM instance.
 *
 * Tracks target normalized-bone UUIDs, so the cache is deliberately scoped to
 * the humanoid object rather than the model URL.
 */
export async function getSharedAvatarClips({
  vrm,
  vrmKind = "none",
  hipsPosition = true,
}: Omit<SharedAvatarClipsArgs, "enabled">): Promise<AnimationClip[]> {
  if (!vrm?.humanoid) return EMPTY_CLIPS;

  const humanoid = vrm.humanoid;
  const cacheKey = sharedAvatarClipCacheKey(vrmKind, hipsPosition);
  let perModel = clipCache.get(humanoid);
  const cached = perModel?.get(cacheKey);
  if (cached) return cached;

  const library = await loadSharedHumanoidClips();
  const clips = retargetHumanoidClips(library, humanoid, {
    // The library is baked in the VRM 1.0 facing convention.
    flipYaw: vrmKind === "vrm0",
    hipsPosition,
  });
  if (!perModel) clipCache.set(humanoid, (perModel = new Map()));
  perModel.set(cacheKey, clips);
  return clips;
}

/**
 * Retarget the shared humanoid library onto `vrm`.
 *
 * Enables `autoUpdateHumanBones` for as long as the retargeted clips are in
 * use, because they drive the normalized rig rather than the raw glTF bones.
 */
export function useSharedAvatarClips({
  vrm,
  vrmKind = "none",
  enabled = true,
  hipsPosition = true,
}: SharedAvatarClipsArgs): AnimationClip[] {
  const [state, setState] = useState<SharedAvatarClipsState>({
    humanoid: null,
    cacheKey: "",
    clips: EMPTY_CLIPS,
  });
  const humanoid = vrm?.humanoid ?? null;
  const cacheKey = sharedAvatarClipCacheKey(vrmKind, hipsPosition);
  // Clips contain target-node UUIDs. Never expose a previous model's clips
  // while the async library import/retarget for the current model is pending.
  const clips =
    enabled &&
    humanoid !== null &&
    state.humanoid === humanoid &&
    state.cacheKey === cacheKey
      ? state.clips
      : EMPTY_CLIPS;

  useEffect(() => {
    if (!enabled || !humanoid) {
      return;
    }

    let cancelled = false;
    getSharedAvatarClips({ vrm, vrmKind, hipsPosition })
      .then((resolvedClips) => {
        if (cancelled) return;
        setState({
          humanoid,
          cacheKey,
          clips: resolvedClips,
        });
      })
      .catch((error) => {
        console.warn(
          "[avatar-renderer] shared animation library failed to load",
          error
        );
      });

    return () => {
      cancelled = true;
    };
  }, [cacheKey, enabled, hipsPosition, humanoid, vrm, vrmKind]);

  useEffect(() => {
    if (!humanoid || clips.length === 0) return;
    const previous = humanoid.autoUpdateHumanBones;
    humanoid.autoUpdateHumanBones = true;
    return () => {
      humanoid.autoUpdateHumanBones = previous;
    };
  }, [clips, humanoid]);

  return clips;
}

/**
 * Embedded clips win over shared ones of the same name, and keep their order.
 * Shared clips only ever fill the gaps.
 */
export function mergeAvatarClips(
  embedded: readonly AnimationClip[],
  shared: readonly AnimationClip[]
): AnimationClip[] {
  if (shared.length === 0) return embedded as AnimationClip[];
  const taken = new Set(
    embedded.map((clip) => clip.name.trim().toLowerCase())
  );
  return [
    ...embedded,
    ...shared.filter((clip) => !taken.has(clip.name.trim().toLowerCase())),
  ];
}
