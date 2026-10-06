/** Build the production transcript, including lazy code viewers and their workers. */
const fs = require("node:fs/promises");
const path = require("node:path");
const desktop = path.resolve(__dirname, "../apps/desktop");

module.exports = async function buildTranscriptFixture(dir, fixture) {
  const htmlName = `.transcript-${Date.now()}-${Math.random().toString(36).slice(2)}.html`;
  const html = path.join(desktop, htmlName);
  await fs.writeFile(
    html,
    `<html data-theme="light"><head><link rel="stylesheet" href="./src/renderer/src/app.css"></head><body><div id="root" style="height:100vh"></div><script type="module" src="../../scripts/fixtures/${fixture}"></script></body></html>`,
  );
  const { build } = await import(require.resolve("vite", { paths: [desktop] }));
  const { default: react } = await import(require.resolve("@vitejs/plugin-react", { paths: [desktop] }));
  const { default: tailwind } = await import(require.resolve("@tailwindcss/vite", { paths: [desktop] }));
  // require.resolve picks the CJS build, whose default is the module object rather than the plugin.
  const typegpuModule = (await import(require.resolve("unplugin-typegpu/vite", { paths: [desktop] }))).default;
  const typegpu = typeof typegpuModule === "function" ? typegpuModule : typegpuModule.default;
  try {
    await build({
      configFile: false,
      root: desktop,
      base: "./",
      logLevel: "error",
      // Fixtures render the production renderer, so QA-only code stays out as it does in a release build.
      define: { __OPENORC_QA__: "false" },
      plugins: [react(), tailwind(), typegpu()],
      resolve: {
        alias: { "@": path.join(desktop, "src/renderer/src"), ...Object.fromEntries(["react", "react-dom", "@tanstack/react-query"].map((name) => [name, path.join(desktop, "node_modules", name)])) },
      },
      build: { outDir: dir, rollupOptions: { input: html } },
    });
    await fs.rename(path.join(dir, htmlName), path.join(dir, "index.html"));
  } finally {
    await fs.rm(html);
  }
};
