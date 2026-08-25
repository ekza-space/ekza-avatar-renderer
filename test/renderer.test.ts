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
  AvatarBufferCache,
  AVATAR_VRM_LOADER_OPTIONS,
  configureAvatarModelScene,
  configureAvatarVrmLoader,
  DEFAULT_AVATAR_PREVIEW_FOV,
  detectVrmKind,
  fitAvatarPreviewCamera,
  measureAvatarBounds,
  measureAvatarSpatialBounds,
  normalizeAvatarBounds,
  readEmbeddedAvatarHeightScale,
  resolveAvatarPreviewTargetHeight,
} from "../src";

describe("AvatarBufferCache", () => {
  it("deduplicates concurrent requests and reports successful bytes", async () => {
    const cache = new AvatarBufferCache(16);
    let loads = 0;
    const load = async () => {
      loads += 1;
      return new ArrayBuffer(4);
    };

    const first = cache.get("avatar", load);
    const second = cache.get("avatar", load);

    expect(first).toBe(second);
    expect(await first).toBe(await second);
    expect(loads).toBe(1);
    expect(cache.stats()).toEqual({
      entries: 1,
      pendingEntries: 0,
      successfulEntries: 1,
      successfulBytes: 4,
      maxBytes: 16,
    });
  });

  it("evicts the least-recently-used successful buffers to its byte budget", async () => {
    const cache = new AvatarBufferCache(6);
    const loads = new Map<string, number>();
    const get = (key: string) =>
      cache.get(key, async () => {
        loads.set(key, (loads.get(key) ?? 0) + 1);
        return new ArrayBuffer(3);
      });

    await get("a");
    await get("b");
    await get("a"); // make a newer than b
    await get("c");

    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
    expect(cache.stats().successfulBytes).toBe(6);

    await get("b");
    expect(loads.get("a")).toBe(1);
    expect(loads.get("b")).toBe(2);
    expect(loads.get("c")).toBe(1);
  });

  it("removes failures and exposes an explicit clear operation", async () => {
    const cache = new AvatarBufferCache(16);

    await expect(
      cache.get("broken", async () => {
        throw new Error("broken");
      })
    ).rejects.toThrow("broken");
    expect(cache.has("broken")).toBe(false);

    await cache.get("avatar", async () => new ArrayBuffer(4));
    cache.clear();
    expect(cache.stats()).toEqual({
      entries: 0,
      pendingEntries: 0,
      successfulEntries: 0,
      successfulBytes: 0,
      maxBytes: 16,
    });
  });

  it("ignores a stale completion after clear and a new same-key request", async () => {
    const cache = new AvatarBufferCache(16);
    let resolveOld!: (buffer: ArrayBuffer) => void;
    let resolveFresh!: (buffer: ArrayBuffer) => void;
    const oldBuffer = new Promise<ArrayBuffer>((resolve) => {
      resolveOld = resolve;
    });
    const freshBuffer = new Promise<ArrayBuffer>((resolve) => {
      resolveFresh = resolve;
    });

    const oldRequest = cache.get("avatar", () => oldBuffer);
    cache.clear();
    const freshRequest = cache.get("avatar", () => freshBuffer);

    resolveOld(new ArrayBuffer(12));
    await oldRequest;
    expect(cache.stats()).toEqual({
      entries: 1,
      pendingEntries: 1,
      successfulEntries: 0,
      successfulBytes: 0,
      maxBytes: 16,
    });

    resolveFresh(new ArrayBuffer(4));
    await freshRequest;
    expect(cache.stats().successfulBytes).toBe(4);
  });
});

describe("configureAvatarModelScene", () => {
  it("propagates both castShadow values through an existing scene", () => {
    const root = new Object3D();
    const child = new Object3D();
    root.add(child);

    configureAvatarModelScene(root, true);
    expect(root.castShadow).toBe(true);
    expect(child.castShadow).toBe(true);
    expect(child.frustumCulled).toBe(false);

    configureAvatarModelScene(root, false);
    expect(root.castShadow).toBe(false);
    expect(child.castShadow).toBe(false);
  });
});

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

  it("returns full posed extents for preview camera framing", () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new Float32BufferAttribute([-2, -1, -3, 4, 5, 6], 3)
    );
    const mesh = new Mesh(geometry, new MeshBasicMaterial());

    expect(measureAvatarSpatialBounds(mesh)).toEqual({
      minX: -2,
      maxX: 4,
      minY: -1,
      maxY: 5,
      minZ: -3,
      maxZ: 6,
    });
  });
});

describe("fitAvatarPreviewCamera", () => {
  const bounds = {
    minX: -0.45,
    maxX: 0.45,
    minY: 0,
    maxY: 1.45,
    minZ: -0.25,
    maxZ: 0.25,
  };

  it("fits the whole rotating avatar in both portrait and landscape", () => {
    const portrait = fitAvatarPreviewCamera({ bounds, aspect: 0.5 });
    const landscape = fitAvatarPreviewCamera({ bounds, aspect: 2 });

    expect(portrait.target).toEqual({ x: 0, y: 0.725, z: 0 });
    expect(portrait.distance).toBeGreaterThan(landscape.distance);

    for (const [aspect, frame] of [
      [0.5, portrait],
      [2, landscape],
    ] as const) {
      const verticalHalfFov = (DEFAULT_AVATAR_PREVIEW_FOV * Math.PI) / 360;
      const horizontalHalfFov = Math.atan(
        Math.tan(verticalHalfFov) * aspect
      );
      const occupiedHalfAngle = Math.asin(frame.radius / frame.distance);
      expect(occupiedHalfAngle).toBeLessThan(
        Math.min(verticalHalfFov, horizontalHalfFov)
      );
      expect(frame.near).toBeGreaterThan(0);
      expect(frame.far).toBeGreaterThan(frame.maxDistance);
    }
  });

  it("keeps finite framing for invalid or degenerate input", () => {
    const frame = fitAvatarPreviewCamera({
      bounds: {
        minX: Number.NaN,
        maxX: Number.POSITIVE_INFINITY,
        minY: 0,
        maxY: 0,
        minZ: 0,
        maxZ: 0,
      },
      aspect: 0,
    });

    expect(Number.isFinite(frame.distance)).toBe(true);
    expect(frame.radius).toBeGreaterThan(0);
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

describe("preview VRM behavior", () => {
  it("keeps the historic height by default and applies embedded deltas", () => {
    expect(resolveAvatarPreviewTargetHeight({})).toBe(1.45);
    expect(
      resolveAvatarPreviewTargetHeight({
        extras: { ekza: { avatar: { heightScale: 1.08 } } },
      })
    ).toBeCloseTo(1.566);
  });

  it("keeps raw-bone animation authoritative during vrm.update", () => {
    expect(AVATAR_VRM_LOADER_OPTIONS.autoUpdateHumanBones).toBe(false);

    let createPlugin: ((parser: unknown) => unknown) | undefined;
    const loader = {
      setDRACOLoader: () => loader,
      register: (factory: (parser: unknown) => unknown) => {
        createPlugin = factory;
        return loader;
      },
    };
    configureAvatarVrmLoader(loader as never);
    const plugin = createPlugin?.({
      json: { extensions: {}, extensionsUsed: [] },
    }) as
      | { humanoidPlugin?: { autoUpdateHumanBones?: boolean } }
      | undefined;
    expect(plugin?.humanoidPlugin?.autoUpdateHumanBones).toBe(false);
  });
});
