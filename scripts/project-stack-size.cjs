/** Verify pinned assets and measure the isolated payload, excluding React. Not an installer-size estimate. */
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { build } = require(require.resolve("esbuild", { paths: [require("node:path").join(__dirname, "../apps/desktop")] }));
const { gzipSync } = require("node:zlib");

async function measure() {
  const root = path.resolve(__dirname, "..");
  const directory = path.join(root, "apps/desktop/src/renderer/src/assets/project-stacks");
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  const assets = manifest.assets.map((asset) => {
    const bytes = fs.readFileSync(path.join(directory, asset.file));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256, `${asset.file}: upstream bytes changed`);
    assert.equal(bytes.length, asset.bytes);
    return bytes;
  });
  const result = await build({
    absWorkingDir: root,
    stdin: {
      contents: 'export { ProjectStackIcon } from "./apps/desktop/src/renderer/src/components/ProjectStackIcon"; export { PROJECT_STACK_LABELS } from "./apps/desktop/src/shared/project-stack-icons";',
      resolveDir: root,
      loader: "tsx",
    },
    bundle: true,
    write: false,
    outdir: "/tmp/openorc-project-stack-size",
    loader: { ".svg": "file" },
    minify: true,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    external: ["react", "react/*"],
  });
  const payload = Buffer.concat(result.outputFiles.map((file) => file.contents));
  console.log(
    JSON.stringify({
      icons: assets.length,
      svgBytes: Buffer.concat(assets).length,
      payloadBytes: payload.length,
      gzipBytes: gzipSync(payload).length,
      includes: "Selected Devicon SVGs, component, CSS and labels; React excluded; file assets (Vite may inline small SVGs)",
    }),
  );
}
void measure();
