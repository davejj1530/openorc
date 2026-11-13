import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Each test opens a real ledger through every migration, about 1.5 s alone on a CI runner.
    testTimeout: 30_000,
  },
});
