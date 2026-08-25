import { describe, expect, it } from "vitest";
import {
  AnimationClip,
  Object3D,
  Quaternion,
  QuaternionKeyframeTrack,
  Vector3,
  VectorKeyframeTrack,
} from "three";
import type { VRMHumanBoneName } from "@pixiv/three-vrm";
import {
  decodeBase64,
  decodeQuaternions,
  flipYawQuaternion,
  mergeAnimationNames,
  resolveDrivenParentBone,
  retargetHumanoidClip,
  sortBonesByDepth,
  type HumanoidRigView,
  type SerializedHumanoidClip,
} from "../src/humanoidRetarget";
import { mergeAvatarClips } from "../src/sharedAnimations";

const QUAT_SCALE = 32767;
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Local encoder so the tests stay free of `Buffer` and of the code under test. */
function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const chunk = [bytes[i], bytes[i + 1] ?? 0, bytes[i + 2] ?? 0];
    const value = (chunk[0] << 16) | (chunk[1] << 8) | chunk[2];
    const chars = [18, 12, 6, 0].map((shift) =>
      BASE64_ALPHABET[(value >> shift) & 63]
    );
    const remaining = bytes.length - i;
    if (remaining === 1) out += chars[0] + chars[1] + "==";
    else if (remaining === 2) out += chars[0] + chars[1] + chars[2] + "=";
    else out += chars.join("");
  }
  return out;
}

function encodeQuaternions(frames: number[][]): string {
  const flat = frames.flat();
  const quantized = new Int16Array(flat.length);
  for (let i = 0; i < flat.length; i += 1) {
    quantized[i] = Math.round(flat[i] * QUAT_SCALE);
  }
  return encodeBase64(new Uint8Array(quantized.buffer));
}

function encodeVectors(frames: number[][]): string {
  return encodeBase64(new Uint8Array(new Float32Array(frames.flat()).buffer));
}

function pitch(degrees: number): number[] {
  return new Quaternion()
    .setFromAxisAngle(new Vector3(1, 0, 0), (degrees * Math.PI) / 180)
    .toArray();
}

function yaw(degrees: number): number[] {
  return new Quaternion()
    .setFromAxisAngle(new Vector3(0, 1, 0), (degrees * Math.PI) / 180)
    .toArray();
}

function fakeHumanoid(
  bones: readonly VRMHumanBoneName[],
  hipsRestY = 1
): HumanoidRigView & { nodes: Map<VRMHumanBoneName, Object3D> } {
  const nodes = new Map<VRMHumanBoneName, Object3D>();
  for (const bone of bones) {
    const node = new Object3D();
    node.name = `Normalized_${bone}`;
    nodes.set(bone, node);
  }
  return {
    nodes,
    getNormalizedBoneNode: (name) => nodes.get(name) ?? null,
    normalizedRestPose: { hips: { position: [0, hipsRestY, 0] } },
  };
}

/** Two frames per bone so nothing is silently treated as an empty track. */
function clipOf(
  rotations: Partial<Record<VRMHumanBoneName, number[]>>,
  hips: number[][] = [[0, 1, 0]]
): SerializedHumanoidClip {
  return {
    name: "walk",
    frameCount: 2,
    duration: 1,
    hipsConstant: hips.length === 1,
    hips: encodeVectors(hips),
    tracks: Object.entries(rotations).map(([bone, value]) => ({
      bone: bone as VRMHumanBoneName,
      constant: true,
      quaternions: encodeQuaternions([value as number[]]),
    })),
  };
}

function trackFor(clip: AnimationClip, node: Object3D) {
  return clip.tracks.find((track) => track.name.startsWith(node.uuid));
}

function worldOf(clip: AnimationClip, node: Object3D): Quaternion {
  const track = trackFor(clip, node);
  if (!track) throw new Error(`no track for ${node.name}`);
  return new Quaternion().fromArray(Array.from(track.values).slice(0, 4));
}

describe("decodeBase64", () => {
  it("round-trips arbitrary bytes without atob or Buffer", () => {
    const bytes = new Uint8Array(256).map((_, index) => index);
    const encoded = encodeBase64(bytes);
    expect(Array.from(decodeBase64(encoded))).toEqual(Array.from(bytes));
  });

  it("decodes payloads of every padding length", () => {
    for (const length of [1, 2, 3, 4, 5]) {
      const bytes = new Uint8Array(length).map((_, i) => i * 7 + 1);
      const encoded = encodeBase64(bytes);
      expect(Array.from(decodeBase64(encoded))).toEqual(Array.from(bytes));
    }
  });
});

describe("decodeQuaternions", () => {
  it("restores unit quaternions from the int16 payload", () => {
    const source = yaw(37);
    const decoded = decodeQuaternions(encodeQuaternions([source]));
    const restored = new Quaternion().fromArray(Array.from(decoded));
    expect(restored.length()).toBeCloseTo(1, 6);
    expect(restored.angleTo(new Quaternion().fromArray(source))).toBeLessThan(
      1e-3
    );
  });
});

describe("flipYawQuaternion", () => {
  it("is its own inverse, so a VRM 0.x round trip is exact", () => {
    const values = new Float32Array(yaw(42).concat(yaw(-13)));
    const original = Array.from(values);
    flipYawQuaternion(values, 0);
    flipYawQuaternion(values, 4);
    expect(Array.from(values)).not.toEqual(original);
    flipYawQuaternion(values, 0);
    flipYawQuaternion(values, 4);
    expect(Array.from(values)).toEqual(original);
  });
});

describe("resolveDrivenParentBone", () => {
  it("returns the immediate parent when it is driven", () => {
    expect(resolveDrivenParentBone("leftLowerArm", () => true)).toBe(
      "leftUpperArm"
    );
  });

  it("skips human bones the model does not define", () => {
    const driven = new Set<VRMHumanBoneName>(["hips", "spine"]);
    // neck -> upperChest -> chest -> spine
    expect(
      resolveDrivenParentBone("neck", (bone) => driven.has(bone))
    ).toBe("spine");
  });

  it("returns null for the root and for orphaned chains", () => {
    expect(resolveDrivenParentBone("hips", () => true)).toBeNull();
    expect(resolveDrivenParentBone("head", () => false)).toBeNull();
  });
});

describe("sortBonesByDepth", () => {
  it("orders parents before their descendants", () => {
    const sorted = sortBonesByDepth([
      "leftHand",
      "hips",
      "leftUpperArm",
      "spine",
    ]);
    expect(sorted.indexOf("hips")).toBeLessThan(sorted.indexOf("spine"));
    expect(sorted.indexOf("leftUpperArm")).toBeLessThan(
      sorted.indexOf("leftHand")
    );
  });
});

describe("mergeAnimationNames", () => {
  it("keeps embedded names first and drops shared duplicates", () => {
    expect(mergeAnimationNames(["walk", "attack"], ["idle", "Walk"])).toEqual([
      "walk",
      "attack",
      "idle",
    ]);
  });

  it("ignores blank names and repeats inside one list", () => {
    expect(mergeAnimationNames(["idle", " ", "idle"], [])).toEqual(["idle"]);
  });
});

describe("mergeAvatarClips", () => {
  const embedded = new AnimationClip("idle", 1, []);
  const shared = [
    new AnimationClip("Idle", 1, []),
    new AnimationClip("walk", 1, []),
  ];

  it("lets embedded clips win over shared ones of the same name", () => {
    const merged = mergeAvatarClips([embedded], shared);
    expect(merged.map((clip) => clip.name)).toEqual(["idle", "walk"]);
    expect(merged[0]).toBe(embedded);
  });

  it("returns the embedded list untouched when nothing is shared", () => {
    const embeddedOnly = [embedded];
    expect(mergeAvatarClips(embeddedOnly, [])).toBe(embeddedOnly);
  });

  it("uses the shared clips when the model has none", () => {
    expect(mergeAvatarClips([], shared).map((clip) => clip.name)).toEqual([
      "Idle",
      "walk",
    ]);
  });
});

describe("retargetHumanoidClip", () => {
  const bones: VRMHumanBoneName[] = [
    "hips",
    "spine",
    "chest",
    "upperChest",
    "neck",
  ];
  const rotations = {
    hips: yaw(0),
    spine: yaw(10),
    chest: yaw(20),
    upperChest: yaw(30),
    neck: yaw(40),
  } as const;

  it("binds tracks to the normalized bone nodes by uuid", () => {
    const humanoid = fakeHumanoid(bones);
    const clip = retargetHumanoidClip(clipOf(rotations), humanoid)!;
    expect(clip.name).toBe("walk");
    for (const bone of bones) {
      const node = humanoid.nodes.get(bone)!;
      expect(trackFor(clip, node)?.name).toBe(`${node.uuid}.quaternion`);
    }
  });

  it("passes stored local rotations straight through when the rig matches", () => {
    const humanoid = fakeHumanoid(bones);
    const clip = retargetHumanoidClip(clipOf(rotations), humanoid)!;
    const chest = worldOf(clip, humanoid.nodes.get("chest")!);
    expect(chest.angleTo(new Quaternion().fromArray(rotations.chest))).toBeLessThan(
      1e-3
    );
  });

  it("re-parents around human bones the target model lacks", () => {
    // The source rig drives spine->chest->upperChest; this target has no chest,
    // so upperChest must absorb chest's rotation to land in the same place.
    const humanoid = fakeHumanoid(["hips", "spine", "upperChest", "neck"]);
    const clip = retargetHumanoidClip(clipOf(rotations), humanoid)!;
    const upperChest = worldOf(clip, humanoid.nodes.get("upperChest")!);
    const expected = new Quaternion()
      .fromArray(rotations.chest)
      .multiply(new Quaternion().fromArray(rotations.upperChest));
    expect(upperChest.angleTo(expected)).toBeLessThan(1e-3);
    expect(trackFor(clip, humanoid.nodes.get("neck")!)).toBeDefined();
  });

  it("scales the hips track by the target's own hips rest height", () => {
    const humanoid = fakeHumanoid(bones, 0.5);
    const clip = retargetHumanoidClip(
      clipOf(rotations, [
        [0, 1, 0],
        [0, 0.9, 0.2],
      ]),
      humanoid
    )!;
    const hips = clip.tracks.find(
      (track) => track.name === `${humanoid.nodes.get("hips")!.uuid}.position`
    ) as VectorKeyframeTrack;
    const values = Array.from(hips.values);
    expect(values.length).toBe(6);
    for (const [index, expected] of [0, 0.5, 0, 0, 0.45, 0.1].entries()) {
      expect(values[index]).toBeCloseTo(expected, 6);
    }
  });

  it("omits the hips track when translation is disabled", () => {
    const humanoid = fakeHumanoid(bones);
    const clip = retargetHumanoidClip(clipOf(rotations), humanoid, {
      hipsPosition: false,
    })!;
    expect(
      clip.tracks.some((track) => track.name.endsWith(".position"))
    ).toBe(false);
  });

  it("applies the VRM 0.x yaw flip to rotations and hips translation", () => {
    const humanoid = fakeHumanoid(bones);
    // A yaw is invariant under the flip, so lean the spine forward instead.
    const clip = retargetHumanoidClip(
      clipOf({ ...rotations, spine: pitch(25) }, [[0.3, 1, 0.2]]),
      humanoid,
      { flipYaw: true }
    )!;
    const spine = worldOf(clip, humanoid.nodes.get("spine")!);
    expect(spine.angleTo(new Quaternion().fromArray(pitch(-25)))).toBeLessThan(
      1e-3
    );
    const hips = clip.tracks.find(
      (track) => track.name === `${humanoid.nodes.get("hips")!.uuid}.position`
    ) as VectorKeyframeTrack;
    const hipsValues = Array.from(hips.values).slice(0, 3);
    for (const [index, expected] of [-0.3, 1, -0.2].entries()) {
      expect(hipsValues[index]).toBeCloseTo(expected, 6);
    }
  });

  it("returns null when the model shares no human bone with the clip", () => {
    expect(retargetHumanoidClip(clipOf(rotations), fakeHumanoid([]))).toBeNull();
  });

  it("emits playable two-key tracks for constant poses", () => {
    const humanoid = fakeHumanoid(bones);
    const clip = retargetHumanoidClip(clipOf(rotations), humanoid)!;
    const track = trackFor(
      clip,
      humanoid.nodes.get("neck")!
    ) as QuaternionKeyframeTrack;
    expect(Array.from(track.times)).toEqual([0, 1]);
    expect(track.values.length).toBe(8);
  });
});
