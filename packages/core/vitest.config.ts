import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
    // Mocked adapters still need discovery paths at admission. Never inherit
    // a developer CLI: these paths deliberately have no executable. Transport
    // fixtures override them with their own disposable provider binaries.
    env: {
      OPENORC_CODEX_BIN: fileURLToPath(new URL("./test-fixtures/codex-not-installed", import.meta.url)),
      OPENORC_CLAUDE_BIN: fileURLToPath(new URL("./test-fixtures/claude-not-installed", import.meta.url)),
      OPENORC_OPENCODE_BIN: fileURLToPath(new URL("./test-fixtures/opencode-not-installed", import.meta.url)),
    },
  },
});
