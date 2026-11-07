import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
    env: {
      // CI's git runs `git maintenance run --auto` in the background after fetches and commits, which keeps writing into a
      // test repository while its folder is deleted (ENOTEMPTY). No test needs it.
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "maintenance.auto",
      GIT_CONFIG_VALUE_0: "false",
      GIT_CONFIG_KEY_1: "gc.auto",
      GIT_CONFIG_VALUE_1: "0",
    },
  },
});
