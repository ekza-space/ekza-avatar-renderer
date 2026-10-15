# @ekza/avatar-renderer

Shared avatar and item rendering boundary for Ekza surfaces.

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

`AvatarModel` and `AvatarPreview` play the clips a file ships with. Most VRMs —
minted avatars in particular — ship none, so the package also bundles a small humanoid clip
library (`idle`, `walk`, `attack`, `cast`, `death`) that is retargeted onto the
model's VRM humanoid at load time.

- Embedded clips always win. While a model has any, the library is not even
  fetched; bundlers emit it as a separate on-demand chunk.
- The fallback needs a VRM humanoid. A plain skinned GLB without the VRM
  extension keeps its previous behaviour: embedded clips only.
- `AvatarPreview` automatically plays the same shared `idle` fallback.
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

## Item previews and lighting

`AssetPreview` (from `@ekza/avatar-renderer/preview`) uses the same plain-Three
runtime as `AvatarPreview`. It accepts static GLB items without applying humanoid
height or idle-animation rules. Existing `AvatarPreview` imports remain supported;
`AvatarModel` in Space's R3F scene is unchanged.

```tsx
import { AssetPreview, PREVIEW_LIGHTING_PRESETS } from "@ekza/avatar-renderer/preview";

<AssetPreview
  url={approved.downloadUrl}
  kind="item"
  integrity={{ sha256: approved.sha256, sizeBytes: approved.sizeBytes }}
  embeddedOnly
  lighting={PREVIEW_LIGHTING_PRESETS.studio}
  shading="original"
  exposure={1}
  autoRotate={false}
  style={{ height: 420 }}
/>
```

- `kind`: `item` (default, fits the longest dimension) or `avatar` (posed-height
  normalization, embedded animations / shared VRM idle).
- `lighting`: `studio`, `daylight`, `dramatic` presets or a custom object with
  `ambient`, `key`, and `fill` colors/intensities and directional positions.
- `shading`: `original` preserves file materials; `clay` and `wireframe` are
  temporary instance overrides. Originals are restored on cleanup.
- `toneMapping`: `aces` (item default) or `none` (legacy avatar default).
  `exposure` ranges from 0.1 to 4 and affects ACES tone mapping.
- `variants`: host-defined `{ id, nodeName, scale? }[]`, with a selected `variant`.
  Parts are matched to original glTF node names through parser associations.
  A host may explicitly use `scale: 1` for alternates authored at zero scale.
  Missing variants fail the preview; game conventions stay outside the SDK.
- Lighting, shading, rotation and variant changes update the live scene without
  downloading or parsing the model again. Each variant gets fresh visible bounds.
- `integrity`: verify exact size/SHA-256 before parsing. `maxBytes` defaults to
  64 MiB, with a streaming limit, abort on unmount and a 30-second load timeout.
  Downloads omit credentials by default and refuse redirects. `embeddedOnly` blocks external
  resource URLs; embedded blob/data resources remain supported. Existing Draco
  support may use the shared decoder configured by the package.
- `playAnimations`: opt into embedded animation for an item such as a waving
  sculpture. Avatars retain their existing animated default; items remain static
  unless enabled. An idle clip is preferred, otherwise the first embedded clip.
  Shared humanoid fallback clips remain avatar-only. Set `false` to freeze either
  kind. The preview owns and cleans up its animation mixer.
- `fetchCredentials`: `omit` by default; `same-origin` enables the host's private
  model proxy to use its existing session cookie. Cross-origin credential
  inclusion is unsupported, and redirects remain forbidden. Use an approved
  proxy URL with `integrity` and `embeddedOnly` for private moderation previews.
- `onStateChange`: `loading`, `ready`, `failed`. Supply a localized `fallback`.
  Unsupported/lost WebGL contexts fall back; unmount releases GPU resources.

Resolve authorization and approved URLs in the host. Open previews on demand,
keep a poster fallback, and prefer one active canvas for a catalogue. Web lighting
is illustrative, not a promise of pixel-identical results in a game engine.
