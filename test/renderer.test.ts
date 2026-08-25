import { describe, expect, it } from "vitest";
import {
  Bone,
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
} from "three";
import {
  detectVrmKind,
  measureAvatarBounds,
  normalizeAvatarBounds,
  readEmbeddedAvatarHeightScale,
} from "../src";

describe("measureAvatarBounds", () => {
  it("measures posed skinned vertices instead of the static geometry box", () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new Float32BufferAttribute([0, 0, 0, 0, 1, 0], 3)
    );
    geometry.setAttribute(
      "skinIndex",
      new Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0], 4)
    );
    geometry.setAttribute(
      "skinWeight",
      new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0], 4)
    );

    const bone = new Bone();
    const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial());
    mesh.add(bone);
    mesh.bind(new Skeleton([bone]));
    bone.scale.y = 4;

    const root = new Object3D();
    root.add(mesh);

    expect(measureAvatarBounds(root)).toEqual({ minY: 0, maxY: 4 });
  });

  it("uses current morph influences rather than every target extreme", () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new Float32BufferAttribute([0, 0, 0, 0, 1, 0], 3)
    );
    geometry.morphAttributes.position = [
      new Float32BufferAttribute([0, 0, 0, 0, 3, 0], 3),
      new Float32BufferAttribute([0, 0, 0, 0, 100, 0], 3),
    ];

    const mesh = new Mesh(geometry, new MeshBasicMaterial());
    mesh.updateMorphTargets();
    if (!mesh.morphTargetInfluences) {
      throw new Error("Three did not initialize morph influences");
    }
    mesh.morphTargetInfluences[0] = 0.5;
    mesh.morphTargetInfluences[1] = 0;

    expect(measureAvatarBounds(mesh)).toEqual({ minY: 0, maxY: 2 });
  });
});

describe("detectVrmKind", () => {
  it("detects legacy and modern VRM containers by glTF metadata", () => {
    expect(detectVrmKind({ extensions: { VRM: {} } })).toBe("vrm0");
    expect(detectVrmKind({ extensionsUsed: ["VRMC_vrm"] })).toBe("vrm1");
    expect(detectVrmKind({ extensionsUsed: ["KHR_materials_unlit"] })).toBe(
      "none"
    );
  });
});

describe("normalizeAvatarBounds", () => {
  it("normalizes height and seats the feet at the requested ground offset", () => {
    expect(
      normalizeAvatarBounds({
        minY: -2,
        maxY: 6,
        targetHeight: 2,
        avatarScale: 1.5,
        groundOffset: 0.25,
      })
    ).toEqual({ scale: 0.375, positionY: 0.5 });
  });

  it("keeps a safe scale for a degenerate model", () => {
    expect(normalizeAvatarBounds({ minY: 0, maxY: 0 })).toEqual({
      scale: 1,
      positionY: 0,
    });
  });

  it("keeps finite output for empty or non-finite bounds", () => {
    expect(
      normalizeAvatarBounds({
        minY: Number.POSITIVE_INFINITY,
        maxY: Number.NEGATIVE_INFINITY,
        groundOffset: Number.NaN,
      })
    ).toEqual({ scale: 1, positionY: 0 });
  });

  it("clamps untrusted instance multipliers", () => {
    expect(
      normalizeAvatarBounds({ minY: 0, maxY: 2, avatarScale: 100 }).scale
    ).toBe(5);
    expect(
      normalizeAvatarBounds({ minY: 0, maxY: 2, avatarScale: 0 }).scale
    ).toBe(0.05);
  });
});

describe("readEmbeddedAvatarHeightScale", () => {
  it("reads the canonical root extras contract", () => {
    expect(
      readEmbeddedAvatarHeightScale({
        extras: { ekza: { avatar: { heightScale: 1.08 } } },
      })
    ).toBe(1.08);
  });

  it("accepts asset extras and clamps untrusted metadata", () => {
    expect(
      readEmbeddedAvatarHeightScale({
        asset: {
          extras: { ekza: { avatar: { heightScale: "999" } } },
        },
      })
    ).toBe(10);
  });

  it("uses a neutral multiplier when metadata is absent or invalid", () => {
    expect(readEmbeddedAvatarHeightScale({})).toBe(1);
    expect(
      readEmbeddedAvatarHeightScale({
        extras: { ekza: { avatar: { heightScale: "giant" } } },
      })
    ).toBe(1);
  });
});
