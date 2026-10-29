import { useEffect, useState } from "react";
import type { VRM } from "@pixiv/three-vrm";
import { buildVrmAsset, disposeVrmAsset, type AvatarVrmAsset, type VrmKind } from "./vrmRuntime";
export * from "./vrmRuntime";

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
