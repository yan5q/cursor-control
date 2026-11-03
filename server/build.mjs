import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  outfile: "dist/index.js",
  sourcemap: true,
});
