export type AvatarNormalization = {
  scale: number;
  positionY: number;
};

/** Pure normalization contract shared by the Space player and Arena preview. */
export function normalizeAvatarBounds(args: {
  minY: number;
  maxY: number;
  targetHeight?: number;
  avatarScale?: number;
  groundOffset?: number;
}): AvatarNormalization {
  const targetHeight = args.targetHeight ?? 1;
  const avatarScale = args.avatarScale ?? 1;
  const groundOffset = args.groundOffset ?? 0;
  const height = args.maxY - args.minY;
  const normalized = height > 1e-4 ? targetHeight / height : 1;
  const scale = normalized * avatarScale;
  const rawPositionY = -groundOffset - args.minY * scale;
  return {
    scale,
    positionY: Object.is(rawPositionY, -0) ? 0 : rawPositionY,
  };
}
