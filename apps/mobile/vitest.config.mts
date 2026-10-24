import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const fixture = (file: string) => resolve(import.meta.dirname, "src/test-fixtures", file);

// Native modules cannot load in Node, so tests draw the phone's views as DOM elements that act as the views do.
export default defineConfig({
  test: {
    alias: {
      "react-native": fixture("react-native.tsx"),
      "react-native-reanimated": fixture("reanimated.tsx"),
      "react-native-safe-area-context": fixture("safe-area.ts"),
      "react-native-svg": fixture("svg.tsx"),
      uniwind: fixture("uniwind.ts"),
    },
  },
});
