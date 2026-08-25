# @ekza/avatar-renderer

Shared avatar rendering boundary for Ekza surfaces.

- `AvatarModel` (`@ekza/avatar-renderer/model`) renders a GLB/VRM inside an
  existing React Three Fiber canvas.
  Space supplies movement, physics and labels around it.
- `AvatarPreview` (`@ekza/avatar-renderer/preview`) supplies its own plain-Three
  canvas, camera, lights and orbit controls for cards and apps such as Arena.
- VRM 0.x receives the legacy Space material/spring-bone enhancement; VRM 1.x
  remains a valid glTF fallback until the Space Three.js stack is upgraded.

The package intentionally does not read Solana or metadata. Resolve ownership
and `modelUrl` through `@ekza/stellar-sdk/avatars`, then pass the URL here.

```tsx
import { AvatarPreview } from "@ekza/avatar-renderer/preview";

<AvatarPreview url={avatar.modelUrl} ariaLabel={`${avatar.name} 3D model`} />;
```
