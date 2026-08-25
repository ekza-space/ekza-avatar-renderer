import type { AvatarSpatialBounds } from "./bounds";
import { readEmbeddedAvatarHeightScale } from "./normalization";

export const DEFAULT_AVATAR_PREVIEW_HEIGHT = 1.45;
export const DEFAULT_AVATAR_PREVIEW_FOV = 32;
export const DEFAULT_AVATAR_PREVIEW_PADDING = 1.12;

export type AvatarPreviewCameraFrame = {
  target: { x: number; y: number; z: number };
  radius: number;
  distance: number;
  minDistance: number;
  maxDistance: number;
  near: number;
  far: number;
};

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function orderedPair(left: number, right: number): [number, number] {
  const a = finiteOr(left, 0);
  const b = finiteOr(right, a);
  return a <= b ? [a, b] : [b, a];
}

/**
 * Calculate a camera orbit that contains the entire bounds at any viewport
 * aspect. A padded bounding sphere is used because Preview auto-rotates around
 * the avatar; fitting only the current front-facing box would clip side views.
 */
export function fitAvatarPreviewCamera(args: {
  bounds: AvatarSpatialBounds;
  aspect: number;
  verticalFovDegrees?: number;
  padding?: number;
}): AvatarPreviewCameraFrame {
  const [minX, maxX] = orderedPair(args.bounds.minX, args.bounds.maxX);
  const [minY, maxY] = orderedPair(args.bounds.minY, args.bounds.maxY);
  const [minZ, maxZ] = orderedPair(args.bounds.minZ, args.bounds.maxZ);
  const target = {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    z: (minZ + maxZ) / 2,
  };

  const halfDiagonal =
    Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2;
  const radius = Math.max(0.05, finiteOr(halfDiagonal, 0.05));
  const aspect = Math.max(0.001, finiteOr(args.aspect, 1));
  const fovDegrees = Math.min(
    120,
    Math.max(1, finiteOr(args.verticalFovDegrees ?? 32, 32))
  );
  const verticalHalfFov = (fovDegrees * Math.PI) / 360;
  const horizontalHalfFov = Math.atan(
    Math.tan(verticalHalfFov) * aspect
  );
  const limitingHalfFov = Math.max(
    0.001,
    Math.min(verticalHalfFov, horizontalHalfFov)
  );
  const padding = Math.max(
    1,
    finiteOr(args.padding ?? DEFAULT_AVATAR_PREVIEW_PADDING, 1)
  );
  const paddedRadius = radius * padding;
  const distance = paddedRadius / Math.sin(limitingHalfFov);
  const minDistance = Math.max(radius * 1.05, distance * 0.35);
  const maxDistance = Math.max(distance * 3, minDistance + radius);

  return {
    target,
    radius,
    distance,
    minDistance,
    maxDistance,
    near: Math.max(0.001, minDistance - radius * 1.01),
    far: Math.max(100, maxDistance + radius * 2),
  };
}

/** Keep Preview's historic size while applying the model-owned height delta. */
export function resolveAvatarPreviewTargetHeight(gltfJson: unknown): number {
  return (
    DEFAULT_AVATAR_PREVIEW_HEIGHT *
    readEmbeddedAvatarHeightScale(gltfJson)
  );
}
