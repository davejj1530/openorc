import { afterEach, expect, it, vi } from "vitest";
import { realpath, readFile } from "node:fs/promises";
import { detectAgentInstallation, type UpdateRunner } from "./agent-update-installation.js";
import { resolveBinary } from "./system.js";
import type { EnvSnapshot } from "./shell-environment.js";
vi.mock("node:fs/promises", () => ({ realpath: vi.fn(), readFile: vi.fn() }));
vi.mock("./system.js", () => ({ resolveBinary: vi.fn() }));
const snapshot: EnvSnapshot = {
  revision: 1,
  shell: "/bin/zsh",
  path: "/prefix/bin",
  binaries: { codex: "/prefix/bin/codex", claude: null, opencode: null },
  env: { HOME: "/home/test", PATH: "/prefix/bin" },
};
afterEach(() => vi.resetAllMocks());
it("updates npm only when the active npm global root owns that installation", async () => {
  vi.mocked(realpath).mockImplementation(async (p) => (String(p) === "/prefix/bin/codex" ? "/prefix/lib/node_modules/@openai/codex/bin/codex.js" : String(p)));
  vi.mocked(resolveBinary).mockResolvedValue("/prefix/bin/npm");
  const run = vi.fn<UpdateRunner>().mockResolvedValue("/prefix/lib/node_modules");
  const install = { binary: "/prefix/bin/npm", args: ["install", "--global", "@openai/codex@latest"] };
  expect(await detectAgentInstallation("codex", "/prefix/bin/codex", snapshot, run)).toMatchObject({ method: "npm", command: install, repair: install });
  run.mockResolvedValue("/another/lib/node_modules");
  expect(await detectAgentInstallation("codex", "/prefix/bin/codex", snapshot, run)).toMatchObject({ command: null, repair: null });
});
it("keeps custom wrappers and pnpm installations manual", async () => {
  for (const target of ["/custom/codex", "/prefix/lib/node_modules/.pnpm/@openai+codex/node_modules/@openai/codex/bin/codex.js"]) {
    vi.mocked(realpath).mockResolvedValue(target);
    expect(await detectAgentInstallation("codex", "/prefix/bin/codex", snapshot)).toMatchObject({ command: null, repair: null });
  }
});
it("uses the owning Homebrew prefix and its release metadata", async () => {
  vi.mocked(realpath).mockResolvedValue("/opt/homebrew/Caskroom/codex/1.0.0/codex");
  vi.mocked(resolveBinary).mockResolvedValue("/opt/homebrew/bin/brew");
  expect(await detectAgentInstallation("codex", "/opt/homebrew/bin/codex", snapshot)).toMatchObject({
    method: "Homebrew",
    releaseUrl: "https://formulae.brew.sh/api/cask/codex.json",
    command: { binary: "/opt/homebrew/bin/brew", args: ["upgrade", "--cask", "codex"] },
    repair: { binary: "/opt/homebrew/bin/brew", args: ["reinstall", "--cask", "codex"] },
  });
  expect(resolveBinary).toHaveBeenCalledWith("brew", "/opt/homebrew/bin");
});
it("preserves Claude’s selected stable channel for native installations", async () => {
  vi.mocked(realpath).mockResolvedValue("/home/test/.local/share/claude/versions/2.1.0");
  vi.mocked(readFile).mockResolvedValue('{"autoUpdatesChannel":"stable"}');
  expect(await detectAgentInstallation("claude", "/home/test/.local/bin/claude", snapshot)).toMatchObject({
    method: "Native · stable",
    releaseUrl: "https://registry.npmjs.org/@anthropic-ai/claude-code/stable",
    command: { binary: "/home/test/.local/bin/claude", args: ["update"] },
    // A broken native binary cannot run its own updater.
    repair: null,
  });
});
it("does not infer native update ownership from a custom Claude launcher", async () => {
  vi.mocked(realpath).mockResolvedValue("/home/test/.local/share/claude/versions/2.1.0");
  expect((await detectAgentInstallation("claude", "/custom/claude", snapshot)).command).toBeNull();
});
