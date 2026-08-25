import {
  AnimationClip,
  Quaternion,
  QuaternionKeyframeTrack,
  VectorKeyframeTrack,
  type KeyframeTrack,
  type Object3D,
} from "three";
import { VRMHumanBoneParentMap, type VRMHumanBoneName } from "@pixiv/three-vrm";

/**
 * Shared humanoid animation, stored independently of any particular model.
 *
 * A track holds the bone's rotation **relative to its rest pose**, expressed in
 * the frame of its driven parent human bone — i.e. exactly what a
 * `VRMHumanoidRig` normalized bone node wants. Because the value is a delta
 * from rest and skips every non-humanoid node of the source rig, it carries no
 * trace of the source model's bone lengths or intermediate joints.
 *
 * Rotations are quantized to int16 and expressed in the VRM 1.0 facing
 * convention; `flipYaw` converts them back for VRM 0.x targets.
 */
export type SerializedHumanoidTrack = {
  bone: VRMHumanBoneName;
  /** `true` when the bone holds one pose for the whole clip (fingers, toes…). */
  constant: boolean;
  /** base64 int16 xyzw quaternions; `constant ? 1 : frameCount` frames. */
  quaternions: string;
};

export type SerializedHumanoidClip = {
  name: string;
  frameCount: number;
  duration: number;
  hipsConstant: boolean;
  /** base64 float32 hips positions, normalized by the source hips rest height. */
  hips: string;
  tracks: SerializedHumanoidTrack[];
};

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

let base64Lookup: Int16Array | null = null;

/**
 * Decode base64 without depending on `atob` (browser) or `Buffer` (Node),
 * both of which are absent in one of the two runtimes this package targets.
 */
export function decodeBase64(input: string): Uint8Array {
  if (!base64Lookup) {
    base64Lookup = new Int16Array(256).fill(-1);
    for (let i = 0; i < BASE64_ALPHABET.length; i += 1) {
      base64Lookup[BASE64_ALPHABET.charCodeAt(i)] = i;
    }
  }
  const lookup = base64Lookup;
  let end = input.length;
  while (end > 0 && input.charCodeAt(end - 1) === 61) end -= 1;
  const bytes = new Uint8Array(Math.floor((end * 3) / 4));
  let byte = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < end; i += 1) {
    const value = lookup[input.charCodeAt(i)];
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[byte++] = (buffer >> bits) & 0xff;
    }
  }
  return byte === bytes.length ? bytes : bytes.subarray(0, byte);
}

/** Turn a copy of the payload into a typed array; `Uint8Array` may be unaligned. */
function toTypedArray<T>(
  bytes: Uint8Array,
  Ctor: { new (buffer: ArrayBuffer): T; BYTES_PER_ELEMENT: number }
): T {
  const aligned = new Uint8Array(bytes.length);
  aligned.set(bytes);
  return new Ctor(aligned.buffer);
}

const QUAT_SCALE = 32767;

/** Decode an int16-quantized quaternion stream back to unit quaternions. */
export function decodeQuaternions(encoded: string): Float32Array {
  const source = toTypedArray(decodeBase64(encoded), Int16Array);
  const values = new Float32Array(source.length);
  for (let i = 0; i < source.length; i += 4) {
    let length = 0;
    for (let c = 0; c < 4; c += 1) {
      const value = source[i + c] / QUAT_SCALE;
      values[i + c] = value;
      length += value * value;
    }
    length = Math.sqrt(length);
    if (length > 0) {
      for (let c = 0; c < 4; c += 1) values[i + c] /= length;
    } else {
      values[i + 3] = 1;
    }
  }
  return values;
}

export function decodeVectors(encoded: string): Float32Array {
  return toTypedArray(decodeBase64(encoded), Float32Array);
}

/**
 * Conjugate a world-space rotation by a 180° yaw, in place.
 *
 * VRM 0.x models face the opposite direction from VRM 1.0 ones in their own
 * scene space, so a clip baked in one convention has to be re-expressed for
 * the other. Applying this twice is the identity, which keeps a VRM 0.x source
 * → VRM 0.x target round trip exact.
 */
export function flipYawQuaternion(
  values: Float32Array,
  offset = 0
): Float32Array {
  values[offset] = -values[offset];
  values[offset + 2] = -values[offset + 2];
  return values;
}

export function flipYawPosition(
  values: Float32Array,
  offset = 0
): Float32Array {
  values[offset] = -values[offset];
  values[offset + 2] = -values[offset + 2];
  return values;
}

/**
 * Nearest ancestor of `bone` that the target rig actually drives.
 *
 * `VRMHumanoidRig` parents each normalized bone to the closest human bone the
 * model defines, and bones we have no baked data for keep an identity local
 * rotation — so both cases are skipped by the same walk.
 */
export function resolveDrivenParentBone(
  bone: VRMHumanBoneName,
  isDriven: (candidate: VRMHumanBoneName) => boolean
): VRMHumanBoneName | null {
  let current: VRMHumanBoneName | null =
    VRMHumanBoneParentMap[bone] ?? null;
  while (current) {
    if (isDriven(current)) return current;
    current = VRMHumanBoneParentMap[current] ?? null;
  }
  return null;
}

/** Merge embedded and shared clip names; embedded names win and keep their order. */
export function mergeAnimationNames(
  embedded: readonly string[],
  shared: readonly string[]
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const list of [embedded, shared]) {
    for (const name of list) {
      const key = name.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(name);
    }
  }
  return merged;
}

/** Minimal view of `VRM.humanoid` this module needs; keeps tests free of a full VRM. */
export type HumanoidRigView = {
  getNormalizedBoneNode(name: VRMHumanBoneName): Object3D | null;
  normalizedRestPose?: Partial<
    Record<VRMHumanBoneName, { position?: number[] } | undefined>
  >;
};

export type RetargetOptions = {
  /** Re-express the canonical VRM 1.0 rotations for a VRM 0.x target. */
  flipYaw?: boolean;
  /** Drive the hips translation track. Disable for in-place locomotion. */
  hipsPosition?: boolean;
};

function readHipsRestHeight(humanoid: HumanoidRigView): number {
  const rest = humanoid.normalizedRestPose?.hips?.position;
  if (rest && Number.isFinite(rest[1]) && Math.abs(rest[1]) > 1e-6) {
    return rest[1];
  }
  const node = humanoid.getNormalizedBoneNode("hips");
  const height = node?.position.y ?? 0;
  return Math.abs(height) > 1e-6 ? height : 1;
}

const _world = new Quaternion();
const _parent = new Quaternion();

function readFrame(
  values: Float32Array,
  frame: number,
  target: Quaternion
): Quaternion {
  const offset = values.length === 4 ? 0 : frame * 4;
  return target.set(
    values[offset],
    values[offset + 1],
    values[offset + 2],
    values[offset + 3]
  );
}

function writeFrame(values: Float32Array, frame: number, source: Quaternion) {
  values[frame * 4] = source.x;
  values[frame * 4 + 1] = source.y;
  values[frame * 4 + 2] = source.z;
  values[frame * 4 + 3] = source.w;
}

/** Order bones parent-first so a single pass can accumulate world rotations. */
export function sortBonesByDepth(
  bones: readonly VRMHumanBoneName[]
): VRMHumanBoneName[] {
  const depth = (bone: VRMHumanBoneName) => {
    let steps = 0;
    let current: VRMHumanBoneName | null = bone;
    while (current) {
      current = VRMHumanBoneParentMap[current] ?? null;
      steps += 1;
    }
    return steps;
  };
  return [...bones].sort((a, b) => depth(a) - depth(b));
}

/**
 * Recompose the world-space rest-pose delta of every baked bone from the
 * stored parent-local rotations.
 */
function composeWorldRotations(
  locals: Map<VRMHumanBoneName, Float32Array>,
  frameCount: number
): Map<VRMHumanBoneName, Float32Array> {
  const world = new Map<VRMHumanBoneName, Float32Array>();
  for (const bone of sortBonesByDepth([...locals.keys()])) {
    const local = locals.get(bone)!;
    const parentBone = resolveDrivenParentBone(bone, (candidate) =>
      locals.has(candidate)
    );
    const parentWorld = parentBone ? world.get(parentBone) : undefined;
    const values = new Float32Array(frameCount * 4);
    for (let frame = 0; frame < frameCount; frame += 1) {
      readFrame(local, frame, _world);
      if (parentWorld) {
        readFrame(parentWorld, frame, _parent);
        _world.premultiply(_parent);
      }
      writeFrame(values, frame, _world);
    }
    world.set(bone, values);
  }
  return world;
}

/**
 * Bind one baked humanoid clip to a concrete VRM humanoid.
 *
 * The returned clip targets the *normalized* bone nodes by uuid, so the caller
 * must keep `vrm.humanoid.autoUpdateHumanBones` enabled for the pose to reach
 * the skinned mesh.
 */
export function retargetHumanoidClip(
  clip: SerializedHumanoidClip,
  humanoid: HumanoidRigView,
  options: RetargetOptions = {}
): AnimationClip | null {
  const { flipYaw = false, hipsPosition = true } = options;

  const frameCount = Math.max(2, clip.frameCount);
  const duration = clip.duration > 0 ? clip.duration : (frameCount - 1) / 24;

  const locals = new Map<VRMHumanBoneName, Float32Array>();
  for (const track of clip.tracks) {
    const values = decodeQuaternions(track.quaternions);
    if (values.length < 4) continue;
    if (flipYaw) {
      for (let i = 0; i < values.length; i += 4) flipYawQuaternion(values, i);
    }
    locals.set(track.bone, values);
  }

  const nodes = new Map<VRMHumanBoneName, Object3D>();
  for (const bone of locals.keys()) {
    const node = humanoid.getNormalizedBoneNode(bone);
    if (node) nodes.set(bone, node);
  }
  if (nodes.size === 0) return null;

  // A bone only needs re-parenting when the target skips a human bone the
  // source rig defined; otherwise the stored local rotation is already correct
  // and constant tracks stay collapsed.
  const reparented = new Map<VRMHumanBoneName, VRMHumanBoneName | null>();
  let needsWorld = false;
  for (const bone of nodes.keys()) {
    const sourceParent = resolveDrivenParentBone(bone, (candidate) =>
      locals.has(candidate)
    );
    const targetParent = resolveDrivenParentBone(
      bone,
      (candidate) => locals.has(candidate) && nodes.has(candidate)
    );
    reparented.set(bone, targetParent);
    if (sourceParent !== targetParent) needsWorld = true;
  }
  const world = needsWorld ? composeWorldRotations(locals, frameCount) : null;

  const times = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    times[i] = (i / (frameCount - 1)) * duration;
  }
  const constantTimes = new Float32Array([0, duration]);

  const tracks: KeyframeTrack[] = [];
  for (const [bone, node] of nodes) {
    let values: Float32Array;
    if (world) {
      const parentBone = reparented.get(bone) ?? null;
      const parentWorld = parentBone ? world.get(parentBone) : undefined;
      const own = world.get(bone)!;
      values = new Float32Array(frameCount * 4);
      for (let frame = 0; frame < frameCount; frame += 1) {
        readFrame(own, frame, _world);
        if (parentWorld) {
          readFrame(parentWorld, frame, _parent);
          _world.premultiply(_parent.invert());
        }
        writeFrame(values, frame, _world);
      }
    } else {
      values = locals.get(bone)!;
    }

    if (values.length === 4) {
      const held = new Float32Array(8);
      held.set(values, 0);
      held.set(values, 4);
      tracks.push(
        new QuaternionKeyframeTrack(
          `${node.uuid}.quaternion`,
          constantTimes,
          held
        )
      );
    } else {
      tracks.push(
        new QuaternionKeyframeTrack(`${node.uuid}.quaternion`, times, values)
      );
    }
  }

  const hipsNode = hipsPosition ? nodes.get("hips") : undefined;
  if (hipsNode) {
    const hips = decodeVectors(clip.hips);
    const height = readHipsRestHeight(humanoid);
    const constant = hips.length === 3;
    const count = constant ? 2 : frameCount;
    const values = new Float32Array(count * 3);
    for (let frame = 0; frame < count; frame += 1) {
      const offset = constant ? 0 : frame * 3;
      values[frame * 3] = hips[offset] * height;
      values[frame * 3 + 1] = hips[offset + 1] * height;
      values[frame * 3 + 2] = hips[offset + 2] * height;
      if (flipYaw) flipYawPosition(values, frame * 3);
    }
    tracks.push(
      new VectorKeyframeTrack(
        `${hipsNode.uuid}.position`,
        constant ? constantTimes : times,
        values
      )
    );
  }

  return new AnimationClip(clip.name, duration, tracks);
}

export function retargetHumanoidClips(
  clips: readonly SerializedHumanoidClip[],
  humanoid: HumanoidRigView,
  options: RetargetOptions = {}
): AnimationClip[] {
  const result: AnimationClip[] = [];
  for (const clip of clips) {
    const retargeted = retargetHumanoidClip(clip, humanoid, options);
    if (retargeted) result.push(retargeted);
  }
  return result;
}
