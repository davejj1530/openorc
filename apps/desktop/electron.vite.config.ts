import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import typegpu from "unplugin-typegpu/vite";

// Electron and native modules load at runtime instead of being bundled; they
// carry platform binaries or resolve their own, so they must be direct
// dependencies of this app to resolve from its node_modules.
// Packaging audits the compiled imports against scripts/packaged-runtime-dependencies.cjs.
const nodeExternals = ["electron", "electron-updater", "node-pty", "sqlite-vec", "fastembed", "onnxruntime-node"];

export default defineConfig(({ mode }) => {
  // Test switches (autorun, benchmarks, screenshots) exist only in development and QA builds. OPENORC_QA_BUILD=1 keeps
  // them in a production build for the benchmark job; release and local packages leave them out entirely.
  const define = { __OPENORC_QA__: JSON.stringify(mode === "development" || process.env["OPENORC_QA_BUILD"] === "1") };
  return {
    main: {
      define,
      build: {
        rollupOptions: {
          input: {
            index: resolve(import.meta.dirname, "src/main/index.ts"),
            core: resolve(import.meta.dirname, "src/core/index.ts"),
            // The core starts this as a worker thread by file name.
            "embedder-worker": resolve(import.meta.dirname, "src/core/embedder-worker.ts"),
          },
          external: nodeExternals,
        },
      },
    },
    preload: {
      define,
      build: {
        rollupOptions: {
          input: { index: resolve(import.meta.dirname, "src/preload/index.ts") },
          external: nodeExternals,
          // The renderer is sandboxed, and sandboxed preloads must be CommonJS.
          output: { format: "cjs", entryFileNames: "[name].js" },
        },
      },
    },
    renderer: {
      // typegpu compiles the shader components' "use gpu" function bodies to WGSL at
      // build time. Without it every orb throws "Missing metadata for tgpu.fn function
      // body" the moment its chunk loads. The shadercn install steps omit this.
      plugins: [react(), tailwindcss(), typegpu()],
      define,
      resolve: {
        alias: { "@": resolve(import.meta.dirname, "src/renderer/src") },
      },
    },
  };
});
