#!/usr/bin/env node
/**
 * Bake humanoid clips out of a VRM into the model-independent format consumed
 * by `src/sharedAnimationData.ts`.
 *
 * The output stores, per human bone, the *world-space delta from the rest
 * pose* — exactly the quantity `VRMHumanoidRig` expects on its normalized
 * bones. That makes the result independent of bone lengths, of the intermediate
 * (non-humanoid) nodes a rig may contain, and of which optional human bones a
 * target model happens to define.
 *
 * Usage:
 *   node scripts/bake-shared-animations.mjs <source.vrm|.glb> [--out src/sharedAnimationData.ts]
 *                                           [--fps 30] [--clips idle,walk,...]
 */
import fs from "node:fs";
import path from "node:path";
import { Object3D, Quaternion, Vector3 } from "three";
import { VRMHumanBoneList, VRMHumanBoneParentMap } from "@pixiv/three-vrm";

const QUAT_SCALE = 32767;

// VRM 0.x spelled the thumb chain one joint "higher" than VRM 1.0 does.
const VRM0_BONE_ALIASES = {
  leftThumbProximal: "leftThumbMetacarpal",
  leftThumbIntermediate: "leftThumbProximal",
  rightThumbProximal: "rightThumbMetacarpal",
  rightThumbIntermediate: "rightThumbProximal",
};

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) flags[token.slice(2)] = argv[++i];
    else positional.push(token);
  }
  return { positional, flags };
}

function readGlb(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.readUInt32LE(0) !== 0x46546c67) throw new Error(`not a GLB: ${file}`);
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset < bytes.length) {
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk));
    else if (type === 0x004e4942) bin = chunk;
    offset += 8 + length;
  }
  if (!json) throw new Error(`no JSON chunk: ${file}`);
  return { json, bin };
}

const COMPONENT_TYPES = {
  5120: Int8Array,
  5121: Uint8Array,
  5122: Int16Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
};
const TYPE_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const NORMALIZE_DIVISOR = {
  5120: 127,
  5121: 255,
  5122: 32767,
  5123: 65535,
};

/** Read a glTF accessor as a plain float array (interleaving is not used by animation data). */
function readAccessor(json, bin, index) {
  const accessor = json.accessors[index];
  const view = json.bufferViews[accessor.bufferView];
  const Ctor = COMPONENT_TYPES[accessor.componentType];
  const components = TYPE_COMPONENTS[accessor.type];
  const byteOffset =
    bin.byteOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const raw = new Ctor(
    bin.buffer.slice(
      byteOffset,
      byteOffset + accessor.count * components * Ctor.BYTES_PER_ELEMENT
    )
  );
  if (!accessor.normalized || Ctor === Float32Array) return { data: raw, components };
  const divisor = NORMALIZE_DIVISOR[accessor.componentType];
  const data = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) data[i] = Math.max(raw[i] / divisor, -1);
  return { data, components };
}

/** Rebuild the glTF node hierarchy as bare Object3Ds — no GLTFLoader, no DOM. */
function buildNodes(json) {
  const nodes = json.nodes.map((def, index) => {
    const object = new Object3D();
    object.name = def.name ?? `node_${index}`;
    if (def.matrix) {
      object.matrix.fromArray(def.matrix);
      object.matrix.decompose(object.position, object.quaternion, object.scale);
    } else {
      if (def.translation) object.position.fromArray(def.translation);
      if (def.rotation) object.quaternion.fromArray(def.rotation);
      if (def.scale) object.scale.fromArray(def.scale);
    }
    return object;
  });
  json.nodes.forEach((def, index) => {
    for (const child of def.children ?? []) nodes[index].add(nodes[child]);
  });
  const root = new Object3D();
  const sceneIndex = json.scene ?? 0;
  for (const index of json.scenes[sceneIndex].nodes) root.add(nodes[index]);
  return { root, nodes };
}

/** Mirror of `resolveDrivenParentBone` in src/humanoidRetarget.ts. */
function resolveDrivenParent(bone, isDriven) {
  let current = VRMHumanBoneParentMap[bone] ?? null;
  while (current) {
    if (isDriven(current)) return current;
    current = VRMHumanBoneParentMap[current] ?? null;
  }
  return null;
}

function readHumanBones(json) {
  const vrm0 = json.extensions?.VRM?.humanoid?.humanBones;
  if (Array.isArray(vrm0)) {
    const map = new Map();
    for (const entry of vrm0) {
      const bone = VRM0_BONE_ALIASES[entry.bone] ?? entry.bone;
      if (VRMHumanBoneList.includes(bone)) map.set(bone, entry.node);
    }
    return { map, vrm0: true };
  }
  const vrm1 = json.extensions?.VRMC_vrm?.humanoid?.humanBones;
  if (vrm1) {
    const map = new Map();
    for (const [bone, entry] of Object.entries(vrm1)) {
      if (VRMHumanBoneList.includes(bone)) map.set(bone, entry.node);
    }
    return { map, vrm0: false };
  }
  throw new Error("source model has no VRM humanoid map");
}

/** Per-node keyframe samplers grouped by animated glTF path. */
function readAnimation(json, bin, animation) {
  const channels = new Map();
  for (const channel of animation.channels) {
    const node = channel.target?.node;
    if (node == null) continue;
    const sampler = animation.samplers[channel.sampler];
    const input = readAccessor(json, bin, sampler.input);
    const output = readAccessor(json, bin, sampler.output);
    let entry = channels.get(node);
    if (!entry) channels.set(node, (entry = {}));
    entry[channel.target.path] = {
      times: input.data,
      values: output.data,
      components: output.components,
      interpolation: sampler.interpolation ?? "LINEAR",
    };
  }
  let duration = 0;
  for (const entry of channels.values()) {
    for (const track of Object.values(entry)) {
      duration = Math.max(duration, track.times[track.times.length - 1] ?? 0);
    }
  }
  return { channels, duration };
}

function findKeyframe(times, time) {
  if (time <= times[0]) return { index: 0, alpha: 0 };
  const last = times.length - 1;
  if (time >= times[last]) return { index: last, alpha: 0 };
  let low = 0;
  let high = last;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (times[mid] <= time) low = mid;
    else high = mid;
  }
  const span = times[high] - times[low];
  return { index: low, alpha: span > 0 ? (time - times[low]) / span : 0 };
}

const _qA = new Quaternion();
const _qB = new Quaternion();

function sampleTrack(track, time, target) {
  const { index, alpha } = findKeyframe(track.times, time);
  const stride = track.components;
  // CUBICSPLINE stores [inTangent, value, outTangent]; the value is the middle.
  const spline = track.interpolation === "CUBICSPLINE";
  const offset = spline ? stride * 3 : stride;
  const read = (i, out) => {
    const base = i * offset + (spline ? stride : 0);
    for (let c = 0; c < stride; c += 1) out[c] = track.values[base + c];
  };
  const a = new Array(stride);
  read(index, a);
  if (alpha === 0 || track.interpolation === "STEP") return target(a);
  const b = new Array(stride);
  read(index + 1, b);
  if (stride === 4) {
    _qA.fromArray(a);
    _qB.fromArray(b);
    _qA.slerp(_qB, alpha);
    return target(_qA.toArray());
  }
  for (let c = 0; c < stride; c += 1) a[c] += (b[c] - a[c]) * alpha;
  return target(a);
}

/** Conjugate a world-space rotation by a 180° yaw (VRM 0.x ↔ VRM 1.0 facing). */
function flipYawQuaternion(q) {
  return [-q[0], q[1], -q[2], q[3]];
}

function encodeQuaternions(values) {
  const quantized = new Int16Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    quantized[i] = Math.max(
      -QUAT_SCALE,
      Math.min(QUAT_SCALE, Math.round(values[i] * QUAT_SCALE))
    );
  }
  return Buffer.from(quantized.buffer).toString("base64");
}

function encodeFloats(values) {
  return Buffer.from(new Float32Array(values).buffer).toString("base64");
}

function bake(file, { fps, clipNames, constantEpsilon }) {
  const { json, bin } = readGlb(file);
  const { map: humanBones, vrm0 } = readHumanBones(json);
  const { root, nodes } = buildNodes(json);

  root.updateMatrixWorld(true);
  const restRotations = new Map();
  const restPosition = new Vector3();
  const scratch = new Vector3();
  for (const [bone, nodeIndex] of humanBones) {
    const rotation = new Quaternion();
    nodes[nodeIndex].matrixWorld.decompose(scratch, rotation, new Vector3());
    restRotations.set(bone, rotation);
  }
  nodes[humanBones.get("hips")].matrixWorld.decompose(
    restPosition,
    new Quaternion(),
    new Vector3()
  );
  const hipsRestHeight = restPosition.y;
  if (!(hipsRestHeight > 1e-6)) throw new Error("source hips rest height is zero");

  // Snapshot the rest TRS so every sampled frame starts from a clean pose.
  const restLocal = nodes.map((node) => ({
    position: node.position.clone(),
    quaternion: node.quaternion.clone(),
    scale: node.scale.clone(),
  }));

  const clips = [];
  for (const animation of json.animations ?? []) {
    if (clipNames && !clipNames.includes(animation.name)) continue;
    const { channels, duration } = readAnimation(json, bin, animation);
    const frameCount = Math.max(2, Math.round(duration * fps) + 1);
    const bones = [...humanBones.keys()];
    const frames = new Map(bones.map((bone) => [bone, []]));
    const hipsFrames = [];

    const worldRotation = new Quaternion();
    const worldPosition = new Vector3();
    const delta = new Quaternion();

    for (let frame = 0; frame < frameCount; frame += 1) {
      const time = (frame / (frameCount - 1)) * duration;
      for (let i = 0; i < nodes.length; i += 1) {
        nodes[i].position.copy(restLocal[i].position);
        nodes[i].quaternion.copy(restLocal[i].quaternion);
        nodes[i].scale.copy(restLocal[i].scale);
      }
      for (const [nodeIndex, entry] of channels) {
        const node = nodes[nodeIndex];
        if (entry.translation) sampleTrack(entry.translation, time, (v) => node.position.fromArray(v));
        if (entry.rotation) sampleTrack(entry.rotation, time, (v) => node.quaternion.fromArray(v));
        if (entry.scale) sampleTrack(entry.scale, time, (v) => node.scale.fromArray(v));
      }
      root.updateMatrixWorld(true);

      for (const bone of bones) {
        nodes[humanBones.get(bone)].matrixWorld.decompose(
          worldPosition,
          worldRotation,
          scratch
        );
        delta.copy(worldRotation).multiply(restRotations.get(bone).clone().invert());
        const array = vrm0 ? flipYawQuaternion(delta.toArray()) : delta.toArray();
        frames.get(bone).push(array);
        if (bone === "hips") {
          const position = worldPosition.toArray().map((v) => v / hipsRestHeight);
          hipsFrames.push(vrm0 ? [-position[0], position[1], -position[2]] : position);
        }
      }
    }

    // Store each bone's rotation *local to its driven parent* rather than its
    // world delta: locals are what stays constant for fingers and toes, so most
    // tracks collapse to a single keyframe. The world delta — which is what the
    // retarget actually needs — is recomposed at load time by walking the same
    // parent chain, which is fully described by the emitted track list.
    const drivenParent = new Map(
      bones.map((bone) => [bone, resolveDrivenParent(bone, (b) => frames.has(b))])
    );
    const tracks = [];
    for (const bone of bones) {
      const parent = drivenParent.get(bone);
      const list = frames.get(bone).map((frame, index) => {
        const world = new Quaternion().fromArray(frame);
        if (parent) {
          const parentWorld = new Quaternion().fromArray(frames.get(parent)[index]);
          world.premultiply(parentWorld.invert());
        }
        return world.toArray();
      });
      const constant = list.every((frame) =>
        frame.every((value, i) => Math.abs(value - list[0][i]) < constantEpsilon)
      );
      const kept = constant ? [list[0]] : list;
      tracks.push({ bone, constant, quaternions: encodeQuaternions(kept.flat()) });
    }
    const hipsFirst = hipsFrames[0];
    const hipsConstant = hipsFrames.every((frame) =>
      frame.every((value, i) => Math.abs(value - hipsFirst[i]) < 1e-4)
    );
    clips.push({
      name: animation.name,
      fps: (frameCount - 1) / (duration || 1),
      frameCount,
      duration,
      hips: encodeFloats((hipsConstant ? [hipsFirst] : hipsFrames).flat()),
      hipsConstant,
      tracks,
    });
  }
  return { source: path.basename(file), vrm0, clips };
}

function emit(baked, outFile) {
  const clips = baked.clips
    .map((clip) => {
      const tracks = clip.tracks
        .map(
          (track) =>
            `      { bone: ${JSON.stringify(track.bone)}, constant: ${
              track.constant
            }, quaternions: "${track.quaternions}" },`
        )
        .join("\n");
      return `  {
    name: ${JSON.stringify(clip.name)},
    frameCount: ${clip.frameCount},
    duration: ${clip.duration},
    hipsConstant: ${clip.hipsConstant},
    hips: "${clip.hips}",
    tracks: [
${tracks}
    ],
  },`;
    })
    .join("\n");

  const source = `// AUTO-GENERATED by scripts/bake-shared-animations.mjs — do not edit by hand.
//
// Source clips: Quaternius "Universal Animation Library" (CC0 1.0), baked from
// the CC0 "100 Avatars" VRM rig shipped with Ekza Space (${baked.source}).
//
// Rotations are rest-pose-relative and local to each bone's driven parent,
// expressed in the VRM 1.0 facing convention and quantized to int16.
// See src/humanoidRetarget.ts.
import type { SerializedHumanoidClip } from "./humanoidRetarget";

export const SHARED_HUMANOID_CLIPS: SerializedHumanoidClip[] = [
${clips}
];
`;
  fs.writeFileSync(outFile, source);
  return source.length;
}

const { positional, flags } = parseArgs(process.argv.slice(2));
if (positional.length !== 1) {
  console.error("usage: bake-shared-animations.mjs <source.vrm|.glb> [--out file] [--fps 30] [--clips a,b]");
  process.exit(1);
}
const fps = Number(flags.fps ?? 30);
const clipNames = flags.clips ? flags.clips.split(",") : null;
const outFile = path.resolve(
  flags.out ?? path.join(path.dirname(new URL(import.meta.url).pathname), "../src/sharedAnimationData.ts")
);
const constantEpsilon = Number(flags.epsilon ?? 4e-3);
const baked = bake(path.resolve(positional[0]), { fps, clipNames, constantEpsilon });
const size = emit(baked, outFile);
console.log(
  `baked ${baked.clips.length} clip(s) from ${baked.source} (vrm0=${baked.vrm0}) -> ${outFile} (${(size / 1024).toFixed(1)} KiB)`
);
for (const clip of baked.clips) {
  const animated = clip.tracks.filter((t) => !t.constant).length;
  console.log(
    `  ${clip.name.padEnd(8)} ${clip.duration.toFixed(3)}s ${clip.frameCount} frames, ${animated}/${clip.tracks.length} animated bones`
  );
}
