import { describe, expect, it } from "vitest";
import { detectVrmKind, normalizeAvatarBounds } from "../src";

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
});
