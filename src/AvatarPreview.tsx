import { AssetPreview, type AssetPreviewProps } from "./AssetPreview";

export type AvatarPreviewProps = Omit<AssetPreviewProps, "kind">;
/** Backward-compatible avatar entry point; shares the item preview runtime. */
export function AvatarPreview(props: AvatarPreviewProps) {
  return <AssetPreview ariaLabel="3D avatar preview" {...props} kind="avatar" />;
}
