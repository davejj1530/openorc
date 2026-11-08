import { afterEach, expect, it, vi } from "vitest";
import { realpath, readFile, lstat } from "node:fs/promises";
import { detectAgentInstallation, fetchAgentRelease, type UpdateRunner } from "./agent-update-installation.js";
import { OMP_FORMULA } from "./agent-update-homebrew.js";
import { harnessCatalog } from "@openorc/protocol";
import { resolveBinary, type EnvSnapshot } from "./shell-environment.js";
vi.mock("node:fs/promises", () => ({ realpath: vi.fn(), readFile: vi.fn(), lstat: vi.fn() }));
vi.mock("./shell-environment.js", () => ({ resolveBinary: vi.fn() }));
const snapshot: EnvSnapshot = {
  revision: 1,
  shell: "/bin/zsh",
  path: "/prefix/bin",
  binaries: { codex: "/prefix/bin/codex", claude: null, opencode: null, omp: null, cursor: null, pi: null, antigravity: null, fx: null },
  env: { HOME: "/home/test", PATH: "/prefix/bin" },
};
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
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
it.each(["cursor", "antigravity", "fx"] as const)("never infers an npm package for the native-only %s agent", async (id) => {
  vi.mocked(realpath).mockResolvedValue(`/prefix/lib/node_modules/null/bin/${id}`);
  vi.mocked(resolveBinary).mockResolvedValue("/prefix/bin/npm");
  const run = vi.fn<UpdateRunner>().mockResolvedValue("/prefix/lib/node_modules");
  expect((await detectAgentInstallation(id, `/prefix/bin/${id}`, snapshot, run)).command).toBeNull();
  expect(run).not.toHaveBeenCalled();
});
it.each<{ codexHome: string; targetHome?: string; binDir: string; env: EnvSnapshot["env"] }>([
  { codexHome: "/home/test/.codex", binDir: "/home/test/.local/bin", env: {} },
  { codexHome: "/custom/codex-home", binDir: "/custom/bin", env: { CODEX_HOME: "/custom/codex-home", CODEX_INSTALL_DIR: "/custom/bin" } },
  { codexHome: "/home/test/.codex", targetHome: "/storage/codex", binDir: "/home/test/.local/bin", env: { CODEX_RELEASE: "latest" } },
])("updates standalone Codex in $codexHome with its own updater", async ({ codexHome, targetHome = codexHome, binDir, env }) => {
  const binary = `${binDir}/codex`;
  const current = `${targetHome}/packages/standalone/current/bin/codex`;
  const target = `${targetHome}/packages/standalone/releases/0.161.0-aarch64-apple-darwin/bin/codex`;
  const paths = new Map([
    [codexHome, targetHome],
    [binary, target],
    [current, target],
  ]);
  vi.mocked(realpath).mockImplementation(async (p) => paths.get(String(p)) ?? String(p));
  const run = vi.fn<UpdateRunner>();
  expect(await detectAgentInstallation("codex", binary, { ...snapshot, env: { ...snapshot.env, ...env } }, run)).toEqual({
    identity: target,
    method: "Native",
    releaseUrl: "https://registry.npmjs.org/@openai/codex/latest",
    command: { binary, args: ["update"] },
    repair: null,
    message: null,
  });
  expect(run).not.toHaveBeenCalled();
});
it.each([
  { binary: "/custom/codex", version: "0.161.0" },
  { binary: "/home/test/.local/bin/codex", version: "0.160.0" },
])("keeps Codex launchers outside the active standalone installation manual: $binary", async ({ binary, version }) => {
  const paths = new Map([
    [binary, `/home/test/.codex/packages/standalone/releases/${version}-aarch64-apple-darwin/bin/codex`],
    ["/home/test/.codex/packages/standalone/current/bin/codex", "/home/test/.codex/packages/standalone/releases/0.161.0-aarch64-apple-darwin/bin/codex"],
  ]);
  vi.mocked(realpath).mockImplementation(async (p) => paths.get(String(p)) ?? String(p));
  expect(await detectAgentInstallation("codex", binary, snapshot)).toMatchObject({ method: "Manual", command: null, repair: null });
});
it("does not treat a standalone current link outside the releases directory as a native installation", async () => {
  vi.mocked(realpath).mockImplementation(async (p) => (String(p) === "/home/test/.codex" ? String(p) : "/custom/codex"));
  expect(await detectAgentInstallation("codex", "/home/test/.local/bin/codex", snapshot)).toMatchObject({ method: "Manual", command: null, repair: null });
});
it.each([
  ["CODEX_MANAGED_BY_NPM", ""],
  ["CODEX_MANAGED_BY_BUN", ""],
  ["CODEX_MANAGED_BY_PNPM", ""],
  ["CODEX_MANAGED_BY_VITE_PLUS", ""],
  ["CODEX_RELEASE", "0.160.0"],
  ["CODEX_INSTALL_DAEMON_ONLY", "1"],
  ["CODEX_INSTALL_DEFER_SELECTION", "1"],
  ["CODEX_INSTALL_IF_LATEST", "1"],
  ["CODEX_INSTALL_IF_CURRENT", "1"],
])("keeps standalone Codex manual when %s redirects or constrains its updater", async (key, value) => {
  vi.mocked(realpath).mockImplementation(async (p) => (String(p) === "/home/test/.codex" ? String(p) : "/home/test/.codex/packages/standalone/releases/0.161.0-aarch64-apple-darwin/bin/codex"));
  expect(await detectAgentInstallation("codex", "/home/test/.local/bin/codex", { ...snapshot, env: { ...snapshot.env, [key]: value } })).toMatchObject({
    method: "Manual",
    command: null,
    repair: null,
  });
});
it("keeps a standalone-looking Codex launcher manual when the current installation is missing", async () => {
  const binary = "/home/test/.local/bin/codex";
  vi.mocked(realpath).mockImplementation(async (p) => {
    if (String(p) === binary) return "/home/test/.codex/packages/standalone/releases/0.161.0-aarch64-apple-darwin/bin/codex";
    if (String(p) === "/home/test/.codex") return String(p);
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  });
  expect(await detectAgentInstallation("codex", binary, snapshot)).toMatchObject({ method: "Manual", command: null, repair: null });
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
it("offers an in-app update for Oh My Pi installed from its Homebrew tap", async () => {
  vi.mocked(realpath).mockResolvedValue("/opt/homebrew/Cellar/omp/18.18.1/bin/omp");
  vi.mocked(readFile).mockResolvedValue(JSON.stringify({ source: { tap: "can1357/tap", spec: "stable" } }));
  vi.mocked(resolveBinary).mockResolvedValue("/opt/homebrew/bin/brew");
  expect(await detectAgentInstallation("omp", "/opt/homebrew/bin/omp", snapshot)).toMatchObject({
    method: "Homebrew",
    command: { binary: "/opt/homebrew/bin/brew", args: ["upgrade", "--formula", "can1357/tap/omp"] },
    repair: { binary: "/opt/homebrew/bin/brew", args: ["reinstall", "--formula", "can1357/tap/omp"] },
    message: null,
  });
});
it("uses the stable Homebrew formula release for OpenCode", async () => {
  vi.mocked(realpath).mockResolvedValue("/opt/homebrew/Cellar/opencode/2.2.0/bin/opencode");
  vi.mocked(readFile).mockResolvedValue(JSON.stringify({ source: { tap: "homebrew/core", spec: "stable" } }));
  vi.mocked(resolveBinary).mockResolvedValue("/opt/homebrew/bin/brew");
  const install = await detectAgentInstallation("opencode", "/opt/homebrew/bin/opencode", snapshot);
  expect(install).toMatchObject({
    releaseUrl: "https://formulae.brew.sh/api/formula/opencode.json",
    command: { args: ["upgrade", "--formula", "homebrew/core/opencode"] },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response('{"versions":{"stable":"2.2.1","head":"HEAD"}}')),
  );
  expect(await fetchAgentRelease(install.releaseUrl)).toBe("2.2.1");
});
it.each([
  JSON.stringify({ source: { tap: "custom/tap", spec: "stable" } }),
  JSON.stringify({ source: { tap: "can1357/tap", spec: "head" } }),
  JSON.stringify({ source: { tap: "can1357/tap" } }),
  "invalid receipt",
])("does not change an unverified Homebrew formula or channel: %s", async (receipt) => {
  vi.mocked(realpath).mockResolvedValue("/opt/homebrew/Cellar/omp/18.18.1/bin/omp");
  vi.mocked(readFile).mockResolvedValue(receipt);
  const run = vi.fn<UpdateRunner>();
  expect(await detectAgentInstallation("omp", "/opt/homebrew/bin/omp", snapshot, run)).toMatchObject({ method: "Homebrew", command: null, repair: null });
  expect(resolveBinary).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});
it("keeps a pinned formula pinned and explains how to resume updates", async () => {
  vi.mocked(realpath).mockResolvedValue("/opt/homebrew/Cellar/omp/18.18.1/bin/omp");
  vi.mocked(readFile).mockResolvedValue(JSON.stringify({ source: { tap: "can1357/tap", spec: "stable" } }));
  vi.mocked(lstat).mockImplementation(async () => {
    throw Object.assign(new Error("not found"), { code: "ENOENT" });
  });
  vi.mocked(resolveBinary).mockResolvedValue("/opt/homebrew/bin/brew");
  expect((await detectAgentInstallation("omp", "/opt/homebrew/bin/omp", snapshot)).command).not.toBeNull();
  vi.mocked(lstat).mockResolvedValue({} as Awaited<ReturnType<typeof lstat>>);
  expect(await detectAgentInstallation("omp", "/opt/homebrew/bin/omp", snapshot)).toMatchObject({
    command: null,
    repair: null,
    message: "Homebrew has pinned omp. Run brew unpin omp before updating it here.",
  });
});
it("offers no updater when Homebrew's receipt or owning executable is missing", async () => {
  vi.mocked(realpath).mockResolvedValue("/opt/homebrew/Cellar/omp/18.18.1/bin/omp");
  vi.mocked(readFile).mockRejectedValueOnce(new Error("unreadable"));
  expect((await detectAgentInstallation("omp", "/opt/homebrew/bin/omp", snapshot)).command).toBeNull();
  vi.mocked(readFile).mockResolvedValue(JSON.stringify({ source: { tap: "can1357/tap", spec: "stable" } }));
  vi.mocked(resolveBinary).mockResolvedValue(null);
  expect(await detectAgentInstallation("omp", "/opt/homebrew/bin/omp", snapshot)).toMatchObject({
    command: null,
    repair: null,
    message: "Homebrew could not be found. Update in a terminal, then check again.",
  });
});
it("reads Oh My Pi's published formula version without evaluating Ruby or substituting npm's release", async () => {
  const fetch = vi.fn(async () => new Response('class Omp < Formula\n  version "18.18.1"\n  url "https://example.com/omp-18.18.1"\nend'));
  vi.stubGlobal("fetch", fetch);
  expect(await fetchAgentRelease(OMP_FORMULA)).toBe("18.18.1");
  expect(fetch).toHaveBeenCalledTimes(1);
  for (const invalid of ['version "18.18.1-dev"', 'version "18.18.1"; system("exit 1")', 'url "https://example.com/18.18.1"']) {
    fetch.mockResolvedValueOnce(new Response(invalid));
    await expect(fetchAgentRelease(OMP_FORMULA)).rejects.toThrow("did not identify");
  }
});
it.each(["omp", "pi"] as const)("updates and repairs npm-installed %s through the owning package manager", async (id) => {
  const pkg = harnessCatalog[id].cli.npm;
  vi.mocked(realpath).mockImplementation(async (p) => (String(p) === `/prefix/bin/${id}` ? `/prefix/lib/node_modules/${pkg}/dist/cli.js` : String(p)));
  vi.mocked(resolveBinary).mockResolvedValue("/prefix/bin/npm");
  const run = vi.fn<UpdateRunner>().mockResolvedValue("/prefix/lib/node_modules");
  const command = { binary: "/prefix/bin/npm", args: ["install", "--global", `${pkg}@latest`] };
  expect(await detectAgentInstallation(id, `/prefix/bin/${id}`, snapshot, run)).toMatchObject({ method: "npm", command, repair: command });
  run.mockResolvedValueOnce("/different/lib/node_modules");
  expect((await detectAgentInstallation(id, `/prefix/bin/${id}`, snapshot, run)).command).toBeNull();
});
it("preserves Claude’s selected stable channel for native installations", async () => {
  vi.mocked(realpath).mockResolvedValue("/home/test/.local/share/claude/versions/2.1.0");
  vi.mocked(readFile).mockResolvedValue('{"autoUpdatesChannel":"stable"}');
  expect(await detectAgentInstallation("claude", "/home/test/.local/bin/claude", snapshot)).toMatchObject({
    method: "Native · stable",
    releaseUrl: "https://downloads.claude.ai/claude-code-releases/stable",
    command: { binary: "/home/test/.local/bin/claude", args: ["update"] },
    // A broken native binary cannot run its own updater.
    repair: null,
  });
});
it("does not infer native update ownership from a custom Claude launcher", async () => {
  vi.mocked(realpath).mockResolvedValue("/home/test/.local/share/claude/versions/2.1.0");
  expect((await detectAgentInstallation("claude", "/custom/claude", snapshot)).command).toBeNull();
});
it("updates an npm-installed OpenCode through its own package", async () => {
  vi.mocked(realpath).mockImplementation(async (p) => (String(p) === "/prefix/bin/opencode" ? "/prefix/lib/node_modules/@opencode/cli/bin/opencode.exe" : String(p)));
  vi.mocked(resolveBinary).mockResolvedValue("/prefix/bin/npm");
  const run = vi.fn<UpdateRunner>().mockResolvedValue("/prefix/lib/node_modules");
  const install = { binary: "/prefix/bin/npm", args: ["install", "--global", "@opencode/cli@latest"] };
  expect(await detectAgentInstallation("opencode", "/prefix/bin/opencode", snapshot, run)).toMatchObject({
    method: "npm",
    releaseUrl: "https://registry.npmjs.org/@opencode/cli/latest",
    command: install,
    repair: install,
  });
});
