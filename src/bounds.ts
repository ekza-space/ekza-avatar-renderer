import {
  Box3,
  Vector3,
  type BufferAttribute,
  type Mesh,
  type Object3D,
  type SkinnedMesh,
} from "three";

export type AvatarBounds = {
  minY: number;
  maxY: number;
};

type PositionAttribute = Pick<
  BufferAttribute,
  "count" | "getX" | "getY" | "getZ"
>;

function readPosition(
  target: Vector3,
  attribute: PositionAttribute,
  index: number
) {
  return target.set(
    attribute.getX(index),
    attribute.getY(index),
    attribute.getZ(index)
  );
}

function applyMorphTargets(
  mesh: Mesh,
  index: number,
  position: Vector3,
  basePosition: Vector3,
  morphPosition: Vector3
) {
  const influences = mesh.morphTargetInfluences;
  const targets = mesh.geometry.morphAttributes.position as
    | PositionAttribute[]
    | undefined;
  if (!influences || !targets?.length) return;

  basePosition.copy(position);
  for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
    const influence = influences[targetIndex] ?? 0;
    if (influence === 0) continue;

    readPosition(morphPosition, targets[targetIndex], index);
    if (mesh.geometry.morphTargetsRelative) {
      position.addScaledVector(morphPosition, influence);
    } else {
      position.addScaledVector(
        morphPosition.sub(basePosition),
        influence
      );
    }
  }
}

/**
 * Measure the geometry Three.js actually renders instead of its static
 * accessor bounds. The latter contain every morph-target extreme and ignore
 * bone transforms, which can make two equally sized avatars differ by an
 * order of magnitude after normalization.
 */
export function measureAvatarBounds(root: Object3D): AvatarBounds {
  root.updateMatrixWorld(true);

  const bounds = new Box3().makeEmpty();
  const position = new Vector3();
  const basePosition = new Vector3();
  const morphPosition = new Vector3();

  root.traverseVisible((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;

    const positionAttribute = mesh.geometry.getAttribute(
      "position"
    ) as PositionAttribute | undefined;
    if (!positionAttribute) return;

    const skinnedMesh = mesh as SkinnedMesh;
    if (skinnedMesh.isSkinnedMesh) skinnedMesh.skeleton.update();

    for (let index = 0; index < positionAttribute.count; index += 1) {
      readPosition(position, positionAttribute, index);
      applyMorphTargets(
        mesh,
        index,
        position,
        basePosition,
        morphPosition
      );
      if (skinnedMesh.isSkinnedMesh) {
        skinnedMesh.boneTransform(index, position);
      }
      position.applyMatrix4(mesh.matrixWorld);

      if (
        Number.isFinite(position.x) &&
        Number.isFinite(position.y) &&
        Number.isFinite(position.z)
      ) {
        bounds.expandByPoint(position);
      }
    }
  });

  if (bounds.isEmpty()) return { minY: 0, maxY: 0 };
  return { minY: bounds.min.y, maxY: bounds.max.y };
}
