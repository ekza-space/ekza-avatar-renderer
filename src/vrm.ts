import { useEffect, useState } from "react";
import type { AnimationClip } from "three";
import {
  VRMLoaderPlugin,
  VRMUtils,
  type VRM,
} from "@pixiv/three-vrm";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import {
  GLTFLoader,
  type GLTF,
} from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  AvatarBufferCache,
  DEFAULT_AVATAR_BUFFER_CACHE_MAX_BYTES,
  type AvatarBufferCacheStats,
} from "./bufferCache";

export type VrmKind = "vrm0" | "vrm1" | "none";

export type GltfJson =
  | {
      extensions?: Record<string, unknown>;
      extensionsUsed?: string[];
    }
  | null
  | undefined;

/** Classify a parsed glTF without relying on a file extension. */
export function detectVrmKind(json: GltfJson): VrmKind {
  if (!json) return "none";
  if (json.extensions && "VRM" in json.extensions) return "vrm0";
  const used = Array.isArray(json.extensionsUsed) ? json.extensionsUsed : [];
  return used.includes("VRMC_vrm") ? "vrm1" : "none";
}

const DRACO_DECODER_PATH =
  "https://www.gstatic.com/draco/versioned/decoders/1.4.3/";

let sharedDracoLoader: DRACOLoader | null = null;

/**
 * Embedded clips target the raw glTF bones. The VRM default copies its
 * normalized pose back onto those bones during `vrm.update()`, which would
 * overwrite AnimationMixer on every frame.
 */
export const AVATAR_VRM_LOADER_OPTIONS = {
  autoUpdateHumanBones: false,
} as const;

function getDracoLoader(): DRACOLoader {
  if (!sharedDracoLoader) {
    sharedDracoLoader = new DRACOLoader();
    sharedDracoLoader.setDecoderPath(DRACO_DECODER_PATH);
  }
  return sharedDracoLoader;
}

/** Give every shared loader the same Draco decoder used by Space. */
export function configureAvatarGltfLoader(loader: GLTFLoader): GLTFLoader {
  return loader.setDRACOLoader(getDracoLoader());
}

/** Add modern VRM 0.x/1.x decoding to the shared Draco-enabled loader. */
export function configureAvatarVrmLoader(loader: GLTFLoader): GLTFLoader {
  configureAvatarGltfLoader(loader);
  loader.register(
    (parser) => new VRMLoaderPlugin(parser, AVATAR_VRM_LOADER_OPTIONS)
  );
  return loader;
}

// Network bytes are shared, parsed VRM scene graphs are not. VRM managers hold
// direct bone references, so every visible instance must receive a fresh parse.
const bufferCache = new AvatarBufferCache(
  DEFAULT_AVATAR_BUFFER_CACHE_MAX_BYTES
);

/** Release all successfully loaded model bytes (pending callers still settle). */
export function clearAvatarModelBufferCache(): void {
  bufferCache.clear();
}

export function getAvatarModelBufferCacheStats(): AvatarBufferCacheStats {
  return bufferCache.stats();
}

function fetchModelBuffer(url: string): Promise<ArrayBuffer> {
  return bufferCache.get(url, async () => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch model (${response.status}): ${url}`);
    }
    return response.arrayBuffer();
  });
}

function parseGltf(
  url: string,
  buffer: ArrayBuffer,
  configure: (loader: GLTFLoader) => GLTFLoader
): Promise<GLTF> {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    configure(loader);
    const lastSlash = url.lastIndexOf("/");
    const resourcePath = lastSlash >= 0 ? url.slice(0, lastSlash + 1) : "";
    loader.parse(buffer, resourcePath, resolve, reject);
  });
}

export type AvatarVrmAsset = {
  url: string;
  vrm: VRM;
  animations: AnimationClip[];
};

/**
 * Parse a fresh VRM scene together with the clips that target that scene.
 * The caller owns the result and must eventually call `disposeVrmAsset`.
 */
export async function buildVrmAsset(url: string): Promise<AvatarVrmAsset> {
  const buffer = await fetchModelBuffer(url);
  const gltf = await parseGltf(url, buffer, configureAvatarVrmLoader);
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm) {
    VRMUtils.deepDispose(gltf.scene);
    throw new Error(`Model is not a VRM asset: ${url}`);
  }
  return { url, vrm, animations: gltf.animations };
}

/** Backward-compatible builder; the caller still owns and must dispose it. */
export async function buildVrmInstance(url: string): Promise<VRM> {
  return (await buildVrmAsset(url)).vrm;
}

/** Dispose a v1+ VRM scene without relying on the removed `VRM.dispose()`. */
export function disposeVrm(vrm: VRM): void {
  VRMUtils.deepDispose(vrm.scene);
}

/** Dispose an asset returned by `buildVrmAsset`. */
export function disposeVrmAsset(asset: AvatarVrmAsset): void {
  disposeVrm(asset.vrm);
}

/** Upgrade VRM 0.x/1.x and keep its scene and clips from the same fresh parse. */
export function useVrmAsset(
  url: string,
  vrmKind: VrmKind
): AvatarVrmAsset | null {
  const [asset, setAsset] = useState<AvatarVrmAsset | null>(null);

  useEffect(() => {
    setAsset(null);
    if (vrmKind === "none" || !url) return;

    let cancelled = false;
    // Keep ownership in this effect as well as state: a state update can be
    // scheduled and then abandoned before React commits a render that sees it.
    let ownedAsset: AvatarVrmAsset | null = null;
    buildVrmAsset(url)
      .then((instance) => {
        if (cancelled) {
          disposeVrmAsset(instance);
          return;
        }
        ownedAsset = instance;
        setAsset(instance);
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn(
          "[avatar-renderer] VRM enhancement failed; using base glTF",
          url,
          error
        );
      });

    return () => {
      cancelled = true;
      if (ownedAsset) {
        disposeVrmAsset(ownedAsset);
        ownedAsset = null;
      }
    };
  }, [url, vrmKind]);

  return asset?.url === url && vrmKind !== "none" ? asset : null;
}

/** Backward-compatible scene-only hook. */
export function useVrmEnhancement(
  url: string,
  vrmKind: VrmKind
): VRM | null {
  return useVrmAsset(url, vrmKind)?.vrm ?? null;
}
