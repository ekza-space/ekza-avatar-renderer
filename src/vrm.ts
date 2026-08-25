import { useEffect, useState } from "react";
import { VRM } from "@pixiv/three-vrm";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import {
  GLTFLoader,
  type GLTF,
} from "three/examples/jsm/loaders/GLTFLoader.js";

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

// Network bytes are shared, parsed VRM scene graphs are not. VRM managers hold
// direct bone references, so every visible instance must receive a fresh parse.
const bufferCache = new Map<string, Promise<ArrayBuffer>>();

function fetchModelBuffer(url: string): Promise<ArrayBuffer> {
  let cached = bufferCache.get(url);
  if (!cached) {
    cached = fetch(url).then((response) => {
      if (!response.ok) {
        throw new Error(`Failed to fetch model (${response.status}): ${url}`);
      }
      return response.arrayBuffer();
    });
    cached.catch(() => bufferCache.delete(url));
    bufferCache.set(url, cached);
  }
  return cached;
}

function parseGltf(url: string, buffer: ArrayBuffer): Promise<GLTF> {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    configureAvatarGltfLoader(loader);
    const lastSlash = url.lastIndexOf("/");
    const resourcePath = lastSlash >= 0 ? url.slice(0, lastSlash + 1) : "";
    loader.parse(buffer, resourcePath, resolve, reject);
  });
}

export async function buildVrmInstance(url: string): Promise<VRM> {
  const buffer = await fetchModelBuffer(url);
  return VRM.from(await parseGltf(url, buffer));
}

/** Upgrade VRM 0.x to full materials/spring-bones; plain glTF stays visible on failure. */
export function useVrmEnhancement(
  url: string,
  vrmKind: VrmKind
): VRM | null {
  const [vrm, setVrm] = useState<VRM | null>(null);

  useEffect(() => {
    setVrm(null);
    if (vrmKind !== "vrm0" || !url) return;

    let cancelled = false;
    buildVrmInstance(url)
      .then((instance) => {
        if (cancelled) {
          instance.dispose();
          return;
        }
        setVrm(instance);
      })
      .catch((error) => {
        console.warn(
          "[avatar-renderer] VRM enhancement failed; using base glTF",
          url,
          error
        );
      });

    return () => {
      cancelled = true;
    };
  }, [url, vrmKind]);

  useEffect(() => () => vrm?.dispose(), [vrm]);
  return vrm;
}
