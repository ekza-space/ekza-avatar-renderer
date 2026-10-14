import { Mesh, MeshBasicMaterial, MeshStandardMaterial, type Material, type Object3D } from "three";

export type PreviewShading = "original" | "clay" | "wireframe";
export type PreviewLight = { color: string; intensity: number; position: readonly [number, number, number] };
export type PreviewLighting = {
  ambient: { color: string; intensity: number };
  key: PreviewLight;
  fill: PreviewLight;
};
export const PREVIEW_LIGHTING_PRESETS = {
  studio: {
    ambient: { color: "#ffffff", intensity: 0.9 },
    key: { color: "#ffffff", intensity: 1.25, position: [2, 3, 3] },
    fill: { color: "#ffffff", intensity: 0.45, position: [-2, 1, -2] },
  },
  daylight: {
    ambient: { color: "#cde6ff", intensity: 1.2 },
    key: { color: "#fff1d6", intensity: 2.4, position: [3, 5, 2] },
    fill: { color: "#c7dcff", intensity: 0.8, position: [-3, 2, -2] },
  },
  dramatic: {
    ambient: { color: "#c6d6ff", intensity: 0.35 },
    key: { color: "#ffe2b5", intensity: 3, position: [1, 2, 3] },
    fill: { color: "#65dfff", intensity: 2, position: [-2, 1, -3] },
  },
} as const satisfies Record<string, PreviewLighting>;

/** Host-defined model parts. The SDK has no game-specific naming convention. */
export type PreviewVariant = { id: string; nodeName: string; scale?: number };

/** Bind by glTF index: loaders can sanitize node names. Only active-scene nodes count. */
export function bindPreviewVariants(
  root: Object3D,
  associations: Map<object, { nodes?: number }>,
  nodes: { name?: string }[],
  variants: readonly PreviewVariant[],
) {
  const parts = new Map<string, { object: Object3D; variant: PreviewVariant }>();
  root.traverse((object) => {
    const index = associations.get(object)?.nodes;
    if (index === undefined) return;
    for (const variant of variants) {
      if (nodes[index]?.name === variant.nodeName && !parts.has(variant.id))
        parts.set(variant.id, { object, variant });
    }
  });
  if (parts.size !== variants.length) throw new Error("A model variant is missing");
  return (id: string) => {
    if (!parts.has(id)) throw new Error("Unknown model variant");
    for (const [key, { object, variant }] of parts) {
      object.visible = key === id;
      // Some formats hide alternate parts with zero scale. Opt in explicitly.
      if (variant.scale !== undefined && Number.isFinite(variant.scale) && variant.scale > 0)
        object.scale.setScalar(variant.scale);
    }
    root.updateMatrixWorld(true);
  };
}

/** Override only instance materials; restore originals before model disposal. */
export function createPreviewShading(root: Object3D) {
  const originals = new Map<Mesh, Material | Material[]>();
  root.traverse((object) => {
    if ((object as Mesh).isMesh) originals.set(object as Mesh, (object as Mesh).material);
  });
  const clay = new MeshStandardMaterial({ color: "#bac4d0", roughness: 0.8, metalness: 0 });
  const wireframe = new MeshBasicMaterial({ color: "#73def4", wireframe: true });
  return {
    apply(mode: PreviewShading) {
      for (const [mesh, material] of originals)
        mesh.material = mode === "clay" ? clay : mode === "wireframe" ? wireframe : material;
    },
    dispose() {
      for (const [mesh, material] of originals) mesh.material = material;
      clay.dispose();
      wireframe.dispose();
    },
  };
}
