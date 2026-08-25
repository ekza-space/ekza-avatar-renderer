/**
 * Retargeting on a real VRM 1.0 file.
 *
 * The shared library is baked in the VRM 1.0 facing convention and yaw-flipped
 * for VRM 0.x targets, which the renderer pairs with a 180° root rotation. That
 * pairing was reasoned about but never run against an actual VRM 1.0 asset, so
 * a wrong assumption would have shipped avatars walking backwards.
 *
 * Fixture: NeonGlitch86 collection, CC0 (Open Source Avatars).
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin } from "@pixiv/three-vrm";
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { getSharedAvatarClips } from "../src/sharedAnimations";
import { detectVrmKind } from "../src/vrm";

// Node cannot decode images and GLTFLoader waits on that forever; textures do
// not affect skeleton motion.
(globalThis as any).self ??= globalThis;
(globalThis as any).createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
(globalThis as any).URL.createObjectURL ??= () => "blob:stub";
(globalThis as any).URL.revokeObjectURL ??= () => {};

const FIXTURE = join(__dirname, "fixtures", "vrm1-sample.vrm");

async function loadVrm(file: string) {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const buf = readFileSync(file);
  const gltf = await loader.parseAsync(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    ""
  );
  return gltf.userData.vrm;
}

/** How far the left foot travels along the model's forward axis over one cycle. */
function walkExcursion(vrm: any, walk: THREE.AnimationClip, vrmKind: "vrm0" | "vrm1") {
  const root = new THREE.Group();
  root.rotation.y = vrmKind === "vrm0" ? Math.PI : 0; // matches AvatarModel
  root.add(vrm.scene);

  const mixer = new THREE.AnimationMixer(vrm.scene);
  mixer.clipAction(walk).play();

  const hips = vrm.humanoid.getRawBoneNode("hips");
  const foot = vrm.humanoid.getRawBoneNode("leftFoot");
  const forward = new THREE.Vector3();
  const point = new THREE.Vector3();
  const origin = new THREE.Vector3();
  let min = Infinity;
  let max = -Infinity;

  for (let frame = 0; frame < 24; frame++) {
    mixer.setTime(frame / 24);
    vrm.humanoid.update();
    root.updateMatrixWorld(true);
    root.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    hips.getWorldPosition(origin);
    foot.getWorldPosition(point);
    const along = point.sub(origin).dot(forward);
    min = Math.min(min, along);
    max = Math.max(max, along);
  }
  return { min, max };
}

describe("VRM 1.0 retarget", () => {
  it("gives a clipless VRM 1.0 model the shared library", async () => {
    const raw = readFileSync(FIXTURE);
    const json = JSON.parse(
      raw.subarray(20, 20 + raw.readUInt32LE(12)).toString("utf8")
    );
    expect(detectVrmKind(json)).toBe("vrm1");

    const vrm = await loadVrm(FIXTURE);
    const clips = await getSharedAvatarClips({ vrm, vrmKind: "vrm1" });
    expect(clips.map((clip) => clip.name)).toEqual(
      expect.arrayContaining(["idle", "walk"])
    );
  }, 120_000);

  it("swings the foot forward, not backward", async () => {
    const vrm = await loadVrm(FIXTURE);
    const clips = await getSharedAvatarClips({ vrm, vrmKind: "vrm1" });
    const walk = clips.find((clip) => clip.name === "walk")!;
    const { min, max } = walkExcursion(vrm, walk, "vrm1");

    // A wrong yaw convention mirrors the cycle: the foot would peak behind the
    // hips instead of ahead of them.
    expect(max).toBeGreaterThan(0.1);
    expect(min).toBeLessThan(-0.1);
    expect(max - min).toBeGreaterThan(0.3);
  }, 120_000);
});
