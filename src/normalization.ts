export type AvatarNormalization = {
  scale: number;
  positionY: number;
};

export const DEFAULT_AVATAR_TARGET_HEIGHT = 1;
export const MIN_AVATAR_HEIGHT_SCALE = 0.1;
export const MAX_AVATAR_HEIGHT_SCALE = 10;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null
    ? (value as JsonRecord)
    : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampHeightScale(value: unknown): number {
  const parsed = finiteNumber(value) ?? 1;
  return Math.min(
    MAX_AVATAR_HEIGHT_SCALE,
    Math.max(MIN_AVATAR_HEIGHT_SCALE, parsed)
  );
}

/**
 * Read Ekza's optional, model-owned height multiplier from glTF `extras`.
 *
 * Canonical shape:
 * `{ "extras": { "ekza": { "avatar": { "heightScale": 1.05 } } } }`
 *
 * `asset.extras` is accepted as well because some exporters only preserve
 * custom metadata there. Missing/invalid data deliberately resolves to 1.
 */
export function readEmbeddedAvatarHeightScale(gltfJson: unknown): number {
  const root = asRecord(gltfJson);
  if (!root) return 1;

  const candidates = [root.extras, asRecord(root.asset)?.extras];
  for (const candidate of candidates) {
    const extras = asRecord(candidate);
    const ekza = asRecord(extras?.ekza);
    const avatar = asRecord(ekza?.avatar);
    if (avatar && "heightScale" in avatar) {
      return clampHeightScale(avatar.heightScale);
    }
  }

  return 1;
}

/** Pure normalization contract shared by the Space player and Arena preview. */
export function normalizeAvatarBounds(args: {
  minY: number;
  maxY: number;
  targetHeight?: number;
  avatarScale?: number;
  groundOffset?: number;
}): AvatarNormalization {
  const minY = Number.isFinite(args.minY) ? args.minY : 0;
  const maxY = Number.isFinite(args.maxY) ? args.maxY : minY;
  const requestedTargetHeight = finiteNumber(args.targetHeight);
  const targetHeight = Math.max(
    0,
    requestedTargetHeight ?? DEFAULT_AVATAR_TARGET_HEIGHT
  );
  const avatarScale = clampHeightScale(args.avatarScale);
  const groundOffset = finiteNumber(args.groundOffset) ?? 0;
  const height = maxY - minY;
  const normalized = height > 1e-4 ? targetHeight / height : 1;
  const scale = normalized * avatarScale;
  const rawPositionY = -groundOffset - minY * scale;
  return {
    scale,
    positionY: Object.is(rawPositionY, -0) ? 0 : rawPositionY,
  };
}
