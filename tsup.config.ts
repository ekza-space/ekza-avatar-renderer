import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    model: "src/model.ts",
    preview: "src/preview.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  external: [
    "@react-three/fiber",
    "react",
    "react-dom",
    "three",
  ],
  noExternal: ["@pixiv/three-vrm"],
});
