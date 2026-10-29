import { useEffect, useState } from "react";
import type { AnimationClip } from "three";
import { getSharedAvatarClips, type SharedAvatarClipsArgs } from "./sharedAnimationRuntime";
import type { VrmKind } from "./vrmRuntime";
export * from "./sharedAnimationRuntime";
const EMPTY_CLIPS: AnimationClip[] = [];
type SharedAvatarClipsState = {
  humanoid: object | null;
  cacheKey: string;
  clips: AnimationClip[];
};

function sharedAvatarClipCacheKey(
  vrmKind: VrmKind,
  hipsPosition: boolean
): string {
  return `${vrmKind === "vrm0"}:${hipsPosition}`;
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
