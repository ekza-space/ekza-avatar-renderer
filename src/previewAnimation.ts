import { AnimationMixer, type AnimationClip, type Object3D } from "three";

/** Embedded clips work for objects as well as avatars; callers own cleanup. */
export function startPreviewAnimation(
  model: Object3D, clips: readonly AnimationClip[], enabled: boolean,
): AnimationMixer | null {
  if (!enabled || clips.length === 0) return null;
  const mixer = new AnimationMixer(model);
  const clip = clips.find((item) => item.name.trim().toLowerCase() === "idle") ?? clips[0];
  mixer.clipAction(clip).play();
  // Apply the first pose before deriving preview bounds.
  mixer.update(0);
  return mixer;
}
