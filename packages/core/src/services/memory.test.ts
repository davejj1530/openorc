import { describe, expect, it, vi } from "vitest";
import { Db, settings } from "@openorc/db";
import type { ModelOption } from "@openorc/protocol";
import { MemoryService, type ProviderInfo } from "./memory.js";

const silent = { info() {}, warn() {}, error() {} };
const claudeList: ModelOption[] = [
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", agent: "claude", isDefault: true, efforts: [], defaultEffort: null },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", agent: "claude", isDefault: false, efforts: [], defaultEffort: null },
];
const codexList: ModelOption[] = [
  { id: "gpt-6-astra", label: "GPT-6-Astra", agent: "codex", isDefault: true, efforts: [], defaultEffort: null },
  { id: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark", agent: "codex", isDefault: false, efforts: [], defaultEffort: null },
];

function service(login: { claude: boolean; codex: boolean; opencode: boolean }): MemoryService {
  const providers: ProviderInfo = {
    models: async (agent) => (agent === "claude" ? claudeList : codexList),
    loggedIn: async () => login,
    launch: (agent) => ({ revision: 1, binary: agent, env: Object.freeze({ PATH: "/fixture" }) }),
  };
  let saved: string | null = null;
  const secrets = {
    load: async () => saved,
    save: async (value: string) => {
      saved = value;
    },
  };
  const db = Db.memory();
  settings.set(db, "memory.enabled", "true");
  return new MemoryService(db, { dataDir: "/tmp", secrets }, providers, () => {}, silent);
}

describe("distillation provider resolution", () => {
  it("starts off in a new profile and keeps a saved choice", async () => {
    const providers: ProviderInfo = { models: async () => [], loggedIn: async () => ({ claude: true, codex: true, opencode: false }), launch: () => null };
    const fresh = new MemoryService(Db.memory(), { dataDir: "/tmp" }, providers, () => {}, silent);
    expect(fresh.enabled()).toBe(false);
    expect(await fresh.settings()).toMatchObject({ enabled: false, resolved: null, automatic: [], reason: null });
    const saved = Db.memory();
    settings.set(saved, "memory.enabled", "true");
    expect(new MemoryService(saved, { dataDir: "/tmp" }, providers, () => {}, silent).enabled()).toBe(true);
  });

  it("auto summarizes each signed-in agent's runs with its own small model", async () => {
    const s = await service({ claude: true, codex: true, opencode: false }).settings();
    expect(s.provider).toBe("auto");
    expect(s.resolved).toBeNull();
    expect(s.automatic).toEqual([
      { provider: "codex", model: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark", viaApiKey: false },
      { provider: "claude", model: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", viaApiKey: false },
    ]);
    expect(s.reason).toBeNull();
  });

  it("auto lists only signed-in agents", async () => {
    const s = await service({ claude: false, codex: true, opencode: false }).settings();
    expect(s.automatic).toEqual([expect.objectContaining({ provider: "codex", model: "gpt-5.3-codex-spark" })]);
    expect(s.reason).toBeNull();
  });

  it("explains itself when nothing can distill", async () => {
    const s = await service({ claude: false, codex: false, opencode: false }).settings();
    expect(s.resolved).toBeNull();
    expect(s.automatic).toEqual([]);
    expect(s.reason).toMatch(/log in/i);
  });

  it("never sends a run to another provider in auto", async () => {
    const m = service({ claude: true, codex: false, opencode: true });
    expect(await m.extractor("codex")).toBeNull();
    expect(await m.extractor("opencode")).toBeNull();
    expect(await m.extractor("claude")).not.toBeNull();
  });

  it("uses the API key when chosen, even with no CLI login", async () => {
    const m = service({ claude: false, codex: false, opencode: false });
    const s = await m.updateSettings({ provider: "apikey", apiKey: "sk-ant-test" });
    expect(s.resolved).toMatchObject({ provider: "claude", viaApiKey: true });
    expect(s.hasApiKey).toBe(true);
  });

  it("keeps a model choice per provider and null restores the default", async () => {
    const m = service({ claude: true, codex: true, opencode: false });
    await m.updateSettings({ provider: "codex", model: "gpt-6-astra" });
    expect((await m.settings()).resolved?.model).toBe("gpt-6-astra");
    await m.updateSettings({ provider: "claude" });
    expect((await m.settings()).resolved?.model).toBe("claude-haiku-4-5-20251001");
    await m.updateSettings({ provider: "codex" });
    expect((await m.settings()).model).toBe("gpt-6-astra");
    const s = await m.updateSettings({ model: null });
    expect(s.model).toBeNull();
    expect(s.resolved?.model).toBe("gpt-5.3-codex-spark");
  });

  it("pairs an extractor with one admitted binary and environment", async () => {
    const launch = vi.fn((agent: "claude" | "codex") => ({ revision: 7, binary: `/snapshot/${agent}`, env: Object.freeze({ PATH: "/snapshot", REVISION: "7" }) }));
    const providers: ProviderInfo = {
      models: async (agent) => (agent === "claude" ? claudeList : codexList),
      loggedIn: async () => ({ claude: true, codex: true, opencode: false }),
      launch,
    };
    const db = Db.memory();
    settings.set(db, "memory.enabled", "true");
    const memory = new MemoryService(db, { dataDir: "/tmp" }, providers, () => {}, silent);

    await expect(memory.extractor("codex")).resolves.not.toBeNull();
    expect(launch).toHaveBeenCalledWith("codex");
    expect(launch).not.toHaveBeenCalledWith("claude");
  });
});
