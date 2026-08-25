# @ekza/avatar-renderer

Shared avatar rendering boundary for Ekza surfaces.

- `AvatarModel` (`@ekza/avatar-renderer/model`) renders a GLB/VRM inside an
  existing React Three Fiber canvas.
  Space supplies movement, physics and labels around it.
- `AvatarPreview` (`@ekza/avatar-renderer/preview`) supplies its own plain-Three
  canvas, camera, lights and orbit controls for cards and apps such as Arena.
- VRM 0.x and 1.x use the same `VRMLoaderPlugin` material, humanoid and
  spring-bone path. The renderer keeps compatibility with host Three.js
  versions from r137 onward.

The package intentionally does not read Solana or off-chain NFT metadata.
Resolve ownership and `modelUrl` through `@ekza/stellar-sdk/avatars`, then pass
the URL here.

## Height contract

`AvatarModel` measures the visible, skinned neutral pose once (including only
currently active morph targets) and normalizes every model to the host world's
`targetHeight`. `avatarScale` is an instance-level multiplier. A model may
carry a stable, model-owned multiplier in glTF extras:

```json
{
  "extras": {
    "ekza": {
      "avatar": { "heightScale": 1.05 }
    }
  }
}
```

Hosts can override that value with the `avatarHeightScale` prop. Missing or
invalid metadata resolves to `1.0`; accepted multipliers are clamped to
`0.1..10.0`.

```tsx
import { AvatarPreview } from "@ekza/avatar-renderer/preview";

<AvatarPreview url={avatar.modelUrl} ariaLabel={`${avatar.name} 3D model`} />;
```

## Animations

`AvatarModel` plays the clips a file ships with. Most VRMs — minted avatars in
particular — ship none, so the package also bundles a small humanoid clip
library (`idle`, `walk`, `attack`, `cast`, `death`) that is retargeted onto the
model's VRM humanoid at load time.

- Embedded clips always win. While a model has any, the library is not even
  fetched; bundlers emit it as a separate on-demand chunk.
- The fallback needs a VRM humanoid. A plain skinned GLB without the VRM
  extension keeps its previous behaviour: embedded clips only.
- `onAnimationsChange` reports the merged list (embedded first, shared filling
  the gaps). `animState`, `animation` and the `tpose` stop are unchanged.
- Opt out with `sharedAnimations={false}`; keep locomotion in place with
  `sharedHipsPosition={false}`.

The library stores, per human bone, a rest-pose-relative rotation local to its
driven parent — the value a `VRMHumanoidRig` normalized bone expects — so it
carries no trace of the source model's bone lengths, of its non-humanoid joints,
or of which optional human bones it defined. Hips translation is stored
normalized by hips height and rescaled to the target. Rotations are baked in the
VRM 1.0 facing convention and flipped back for VRM 0.x targets.

Re-bake after changing the source rig or clips:

```sh
node scripts/bake-shared-animations.mjs path/to/source.vrm --fps 24
```

### Attribution

The bundled clips come from the **Universal Animation Library** by
[Quaternius](https://quaternius.com/packs/universalanimationlibrary.html)
(**CC0 1.0**), baked from the CC0 "100 Avatars" (Polygonal-Mind /
[Open Source Avatars](https://github.com/ToxSam/open-source-avatars)) VRM rig
shipped with Ekza Space. CC0 requires no attribution; it is credited as good
practice.
