import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import * as runtime from "../src/runtime";
import * as legacy from "../src/vrm";
import { getSharedAvatarClips } from "../src/sharedAnimations";

describe("framework-independent runtime contract", () => {
  it("preserves one loader, buffer cache and animation cache across React and plain JS", () => {
    expect(runtime.buildVrmAsset).toBe(legacy.buildVrmAsset);
    expect(runtime.getAvatarModelBufferCacheStats).toBe(legacy.getAvatarModelBufferCacheStats);
    expect(runtime.getSharedAvatarClips).toBe(getSharedAvatarClips);
  });
  it("bundles for the browser without React or React Three Fiber", async () => {
    const bundle = await build({
      entryPoints: ["src/runtime.ts"], bundle: true, write: false,
      format: "esm", platform: "browser", metafile: true,
      external: ["three", "three/*", "@pixiv/three-vrm"],
    });
    const modules = Object.keys(bundle.metafile!.inputs);
    expect(modules.some((path) => /(?:^|\/)react(?:-dom)?(?:\/|$)|@react-three/.test(path))).toBe(false);
    expect(bundle.outputFiles[0].text).not.toMatch(/from ["']react/);
  });
});
