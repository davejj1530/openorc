import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Two projects because the two halves of this app want different globals. Main
// and shared talk to Node and would only be slowed by a document they never
// touch; anything under the renderer is written against one.
// Tests see a release build. Each project needs its own object because Vitest consumes its define entries.
const define = { __OPENORC_QA__: "false" };

export default defineConfig({
  test: {
    projects: [
      {
        define: { ...define },
        test: {
          name: "node",
          // Every .test.ts in the app, renderer included: the renderer's own
          // logic tests are pure and were written against Node, and moving
          // them under a document changes how module mocks behave.
          include: ["src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        // The plugin and the alias the renderer builds with, so a component
        // resolves under test exactly as it resolves in the app.
        plugins: [react()],
        define: { ...define },
        resolve: { alias: { "@": resolve(import.meta.dirname, "src/renderer/src") } },
        test: {
          name: "renderer",
          // .tsx only, so the split is by what a test needs rather than by
          // where it sits: a test that renders a component says so in its
          // extension, and nothing is collected twice.
          include: ["src/renderer/**/*.test.tsx"],
          environment: "jsdom",
          setupFiles: ["./src/renderer/test-setup.ts"],
        },
      },
    ],
  },
});
