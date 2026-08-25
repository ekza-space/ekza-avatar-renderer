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
