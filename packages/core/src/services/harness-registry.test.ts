import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AcpAdapter, CodexAdapter, PiAdapter } from "@openorc/agents";
import { commitAll, git } from "@openorc/git";
import { harnessCatalog, harnessIds, type CorePush } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";

/**
 * A harness is one registry entry plus one adapter. These tests pin the seams
 * the registry drives, so a new harness cannot need a code change elsewhere.
 */
let root: string;
let dataDir: string;
let core: OpenOrc;
const pushed: CorePush[] = [];

const codexModels = [{ id: "fixture", model: "fixture", displayName: "Fixture", description: "", isDefault: true, hidden: false, efforts: [], defaultEffort: null }];
const acpModels = [
  { id: "openrouter/acme/fast", label: "Acme Fast", provider: { id: "openrouter", label: "OpenRouter" }, isDefault: true, efforts: ["default", "low", "high"], defaultEffort: "default" },
];

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-harness-repo-"));
  dataDir = await mkdtemp(path.join(os.tmpdir(), "openorc-harness-data-"));
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(path.join(root, "README.md"), "# fixture\n");
  await commitAll(root, "init");
  core = await OpenOrc.create({ dataDir, ephemeral: true, transport: { push: (m) => pushed.push(m) } });
  await core.projects.import(root);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await core?.close();
  await rm(root, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

describe("harness registry", () => {
  it("lists models per harness in registry order, each billed to its harness account", async () => {
    // Listing needs each harness binary on the admitted environment before its lister is asked.
    vi.stubEnv("OPENORC_OPENCODE_BIN", "/fixture/opencode");
    vi.stubEnv("OPENORC_OMP_BIN", "/fixture/omp");
    vi.stubEnv("OPENORC_CURSOR_BIN", "/fixture/cursor-agent");
    vi.stubEnv("OPENORC_PI_BIN", "/fixture/pi");
    vi.stubEnv("OPENORC_ANTIGRAVITY_BIN", "/fixture/agy");
    vi.stubEnv("OPENORC_FX_BIN", "/fixture/fx");
    await core.environment.refresh();
    const discovery = vi.spyOn(CodexAdapter.prototype, "listModels").mockResolvedValue(codexModels);
    const acp = vi.spyOn(AcpAdapter.prototype, "listModels").mockResolvedValue(acpModels);
    const pi = vi.spyOn(PiAdapter.prototype, "listModels").mockResolvedValue(acpModels.map((model) => ({ ...model, agent: "pi" })));
    const options = await core.runs.models();
    discovery.mockRestore();
    acp.mockRestore();
    pi.mockRestore();
    vi.unstubAllEnvs();
    await core.environment.refresh();
    const agents = [...new Set(options.map((m) => m.agent))];
    expect(options.find((m) => m.agent === "opencode")).toMatchObject({ efforts: acpModels[0]!.efforts, defaultEffort: "default" });
    expect(options.find((m) => m.agent === "codex")?.fastMode).toBeUndefined();
    expect(agents).toEqual(harnessIds);
    // Claude and Codex bill their own accounts; OpenCode and Oh My Pi models carry the provider they run through.
    for (const option of options)
      expect(option.provider).toEqual(
        option.agent === "opencode" || option.agent === "omp" || option.agent === "pi" || option.agent === "fx"
          ? acpModels[0]!.provider
          : harnessCatalog[option.agent as (typeof harnessIds)[number]].account,
      );
  });
});

it("filters cached catalogs and explicit model requests through the saved enabled agents", async () => {
  const discovery = vi.spyOn(CodexAdapter.prototype, "listModels").mockResolvedValue(codexModels);
  const acp = vi.spyOn(AcpAdapter.prototype, "listModels").mockResolvedValue(acpModels);
  try {
    core.settings.set({ enabledHarnesses: ["codex"] });
    const catalog = await core.runs.modelCatalog(undefined, true);
    expect(catalog.providers.map((provider) => provider.agent)).toEqual(["codex"]);
    expect(catalog.models.every((model) => model.agent === "codex")).toBe(true);
    expect(await core.runs.models("claude")).toEqual([]);
    expect(await core.runs.models("cursor")).toEqual([]);
    expect(await core.runs.models("antigravity")).toEqual([]);
    expect(await core.runs.models("fx")).toEqual([]);
    expect(acp).not.toHaveBeenCalled();
    core.settings.set({ enabledHarnesses: [] });
    expect(await core.runs.models()).toEqual([]);
    core.settings.set({ enabledHarnesses: ["codex"] });
    expect((await core.runs.models()).map((model) => model.agent)).toEqual(["codex"]);
  } finally {
    core.settings.set({ enabledHarnesses: null });
    discovery.mockRestore();
    acp.mockRestore();
  }
});
