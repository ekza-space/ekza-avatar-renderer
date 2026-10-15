import { afterEach, describe, expect, it, vi } from "vitest";
import { Group, Mesh, BoxGeometry, MeshStandardMaterial, AnimationClip, QuaternionKeyframeTrack } from "three";
import { bindPreviewVariants, createPreviewShading } from "../src/previewSettings";
import { measureAvatarSpatialBounds } from "../src/bounds";
import { downloadPreview } from "../src/previewDownload";
import { startPreviewAnimation } from "../src/previewAnimation";

afterEach(() => vi.unstubAllGlobals());

describe("item preview", () => {
  it("plays an embedded item rotation and releases it without changing the static default", () => {
    const root = new Group();
    const paw = new Group();
    paw.name = "LuckyPaw";
    root.add(paw);
    const clip = new AnimationClip("Wave", 2, [new QuaternionKeyframeTrack(
      "LuckyPaw.quaternion", [0, 1, 2], [0, 0, 0, 1, Math.SQRT1_2, 0, 0, Math.SQRT1_2, 0, 0, 0, 1],
    )]);
    expect(startPreviewAnimation(root, [clip], false)).toBeNull();
    expect(paw.quaternion.x).toBe(0);
    const mixer = startPreviewAnimation(root, [clip], true)!;
    mixer.update(1);
    expect(paw.quaternion.x).toBeCloseTo(Math.SQRT1_2);
    mixer.stopAllAction();
    mixer.uncacheRoot(root);
    expect(paw.quaternion.x).toBe(0);
    expect(startPreviewAnimation(root, [], true)).toBeNull();
  });
  it("reveals a zero-scale alternate, hides the other part and reframes visible geometry", () => {
    const root = new Group();
    const first = new Mesh(new BoxGeometry(1, 1, 1));
    const second = new Mesh(new BoxGeometry(5, 2, 1));
    second.scale.setScalar(0);
    // Runtime names are deliberately different from source names.
    root.add(first, second);
    const select = bindPreviewVariants(root, new Map([[first, { nodes: 0 }], [second, { nodes: 1 }]]),
      [{ name: "first" }, { name: "second" }], [
        { id: "a", nodeName: "first", scale: 1 }, { id: "b", nodeName: "second", scale: 1 },
      ]);
    select("a");
    expect(measureAvatarSpatialBounds(root).maxX).toBe(0.5);
    select("b");
    expect(first.visible).toBe(false);
    expect(second.visible).toBe(true);
    expect(measureAvatarSpatialBounds(root).maxX).toBe(2.5);
    expect(() => select("missing")).toThrow();
  });
  it("fails clearly if a declared variant is not in the active scene", () => {
    expect(() => bindPreviewVariants(new Group(), new Map(), [], [{ id: "a", nodeName: "absent" }])).toThrow();
  });
  it("restores original multi-materials and disposes only preview overrides", () => {
    const original = new MeshStandardMaterial({ color: "red" });
    const originalDispose = vi.spyOn(original, "dispose");
    const mesh = new Mesh(new BoxGeometry(), [original]);
    const materials = mesh.material;
    const shading = createPreviewShading(mesh);
    shading.apply("clay");
    expect(mesh.material).not.toBe(materials);
    const override = mesh.material as unknown as MeshStandardMaterial;
    const disposed = vi.spyOn(override, "dispose");
    shading.apply("wireframe");
    shading.apply("original");
    expect(mesh.material).toBe(materials);
    shading.apply("clay");
    shading.dispose();
    expect(mesh.material).toBe(materials);
    expect(disposed).toHaveBeenCalledOnce();
    expect(originalDispose).not.toHaveBeenCalled();
  });
});

describe("approved preview download", () => {
  const signal = () => new AbortController().signal;
  it("allows explicit same-origin proxy authentication but rejects cross-origin credential inclusion", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(new Uint8Array([97, 98, 99])));
    vi.stubGlobal("fetch", fetcher);
    await downloadPreview("/api/studio/private-model", signal(), 4, {
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", sizeBytes: 3,
    }, "same-origin");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: "same-origin", redirect: "error" });
    await expect(downloadPreview("https://other.test/model", signal(), 4, undefined, "include" as never))
      .rejects.toThrow("credentials mode");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("checks exact hash/size and sends no credentials or redirects", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(new Uint8Array([97, 98, 99])));
    vi.stubGlobal("fetch", fetcher);
    const data = await downloadPreview("https://registry.test/model", signal(), 4, {
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", sizeBytes: 3,
    });
    expect(data.byteLength).toBe(3);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: "omit", redirect: "error" });
  });
  it("rejects wrong bytes with the right size", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]))));
    await expect(downloadPreview("https://registry.test/model", signal(), 4, { sha256: "a".repeat(64), sizeBytes: 3 })).rejects.toThrow("hash mismatch");
  });
  it("limits streamed bytes even without Content-Length", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array(20))));
    await expect(downloadPreview("https://registry.test/model", signal(), 10)).rejects.toThrow("size");
  });
  it("rejects truncated and revoked models", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(new Uint8Array(2))).mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(downloadPreview("https://registry.test/model", signal(), 10, { sha256: "a".repeat(64), sizeBytes: 3 })).rejects.toThrow("size mismatch");
    await expect(downloadPreview("https://registry.test/model", signal())).rejects.toThrow("unavailable");
  });
});
