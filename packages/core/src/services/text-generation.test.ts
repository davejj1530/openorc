import { afterEach, describe, expect, it, vi } from "vitest";
import { Db, settings } from "@openorc/db";
import { TextGenerator } from "@openorc/memory";
import type { HarnessId, ModelOption } from "@openorc/protocol";
import { MemoryService, type ProviderInfo } from "./memory.js";
import { TextGenerationService } from "./text-generation.js";

const quiet = { info() {}, warn() {}, error() {} };
const model = (id: string, agent: HarnessId = "codex"): ModelOption => ({ id, label: id, agent, isDefault: true, efforts: ["low", "high"], defaultEffort: "high" });
const databases: Db[] = [];
function fixture(login = { claude: true, codex: true, opencode: false }, models = [model("gpt-6-astra"), model("gpt-5.6-luna")]) {
  const db = Db.memory();
  databases.push(db);
  const providers: ProviderInfo = {
    loggedIn: vi.fn(async () => login),
    models: vi.fn(async (agent) => (agent === "codex" ? models : [model("claude-opus-4-6", "claude")])),
    launch: vi.fn((agent) => ({ revision: 1, binary: `/fixture/${agent}`, env: Object.freeze({ PATH: "/fixture" }) })),
  };
  const invalidate = vi.fn();
  return { db, providers, invalidate, service: new TextGenerationService(db, providers, invalidate) };
}
afterEach(() => {
  vi.restoreAllMocks();
  databases.splice(0).forEach((db) => db.close());
});

describe("independent text generation", () => {
  it("names a conversation with a small model from its own agent in Automatic", async () => {
    const { service, providers } = fixture();
    const title = vi.spyOn(TextGenerator.prototype, "title").mockResolvedValue("CSV export filters");
    expect(await service.settings()).toEqual({ provider: "auto", model: null, resolved: null, reason: null });
    await expect(service.title({ request: "Add CSV", reply: "Done" }, "codex")).resolves.toBe("CSV export filters");
    expect(providers.launch).toHaveBeenCalledWith("codex");
    expect(providers.launch).not.toHaveBeenCalledWith("claude");
    vi.mocked(providers.launch).mockClear();
    await expect(service.title({ request: "Add CSV", reply: "Done" }, "claude")).resolves.toBe("CSV export filters");
    expect(providers.launch).toHaveBeenCalledWith("claude");
    expect(providers.launch).not.toHaveBeenCalledWith("codex");
    expect(title).toHaveBeenCalledTimes(2);
  });

  it("never sends a conversation to another provider in Automatic", async () => {
    const { service, providers } = fixture({ claude: true, codex: false, opencode: false });
    const title = vi.spyOn(TextGenerator.prototype, "title");
    await expect(service.title({ request: "Export", reply: null }, "codex")).resolves.toBeNull();
    expect(providers.launch).not.toHaveBeenCalledWith("claude");
    expect(title).not.toHaveBeenCalled();
  });

  it("never silently substitutes a flagship or fast premium model for a cheap default", async () => {
    const { service } = fixture({ claude: false, codex: true, opencode: false }, [model("gpt-6-astra"), model("gpt-5.3-codex-spark")]);
    const title = vi.spyOn(TextGenerator.prototype, "title");
    expect(await service.updateSettings({ provider: "codex" })).toMatchObject({ resolved: null, reason: expect.stringMatching(/no small model/) });
    await expect(service.title({ request: "Export", reply: null }, "codex")).resolves.toBeNull();
    await service.updateSettings({ provider: "auto" });
    await expect(service.title({ request: "Export", reply: null }, "codex")).resolves.toBeNull();
    expect(title).not.toHaveBeenCalled();
  });

  it("names every conversation with a chosen harness, whichever agent it uses", async () => {
    const { service, providers } = fixture();
    const title = vi.spyOn(TextGenerator.prototype, "title").mockResolvedValue("Named");
    expect((await service.updateSettings({ provider: "claude" })).resolved).toMatchObject({ provider: "claude", model: "claude-haiku-4-5-20251001" });
    await expect(service.title({ request: "Export", reply: null }, "codex")).resolves.toBe("Named");
    expect(providers.launch).toHaveBeenCalledWith("claude");
    expect(providers.launch).not.toHaveBeenCalledWith("codex");
    expect(title).toHaveBeenCalledTimes(1);
  });

  it("resolves OpenCode connected-provider models, persists selections, and skips unavailable cheap models", async () => {
    const { service, db, providers, invalidate } = fixture({ claude: false, codex: false, opencode: true });
    vi.mocked(providers.models).mockResolvedValue([model("openrouter/anthropic/claude-opus-4.6", "opencode"), model("openrouter/google/gemini-2.5-flash-lite", "opencode")]);
    expect((await service.updateSettings({ provider: "opencode" })).resolved).toMatchObject({ provider: "opencode", model: "openrouter/google/gemini-2.5-flash-lite" });
    await service.updateSettings({ provider: "opencode", model: "openrouter/openai/gpt-5-mini" });
    expect((await new TextGenerationService(db, providers, invalidate).settings()).resolved?.model).toBe("openrouter/openai/gpt-5-mini");
    await service.updateSettings({ model: null });
    vi.mocked(providers.models).mockResolvedValue([model("openrouter/anthropic/claude-opus-4.6", "opencode")]);
    expect((await service.settings()).resolved).toBeNull();
  });

  it("persists provider-specific choices separately from memory", async () => {
    const { db, providers, invalidate, service } = fixture();
    const memory = new MemoryService(db, { dataDir: "/tmp" }, providers, invalidate, quiet);
    await memory.updateSettings({ provider: "off" });
    const before = await memory.settings();
    await service.updateSettings({ provider: "codex", model: "gpt-5-mini" });
    await service.updateSettings({ provider: "claude", model: "claude-haiku-4-5" });
    const restored = new TextGenerationService(db, providers, invalidate);
    expect((await restored.updateSettings({ provider: "codex" })).resolved?.model).toBe("gpt-5-mini");
    expect((await restored.updateSettings({ model: null })).resolved?.model).toBe("gpt-5.6-luna");
    expect(await restored.updateSettings({ provider: "auto" })).toMatchObject({ provider: "auto", resolved: null });
    await expect(restored.updateSettings({ model: "gpt-5-mini" })).rejects.toThrow(/choose a provider/i);
    expect(await memory.settings()).toEqual(before);
    expect(invalidate).toHaveBeenCalledWith(["text-generation"]);
  });

  it("generates titles with memory disabled and leaves memory settings untouched", async () => {
    const { db, service } = fixture();
    settings.set(db, "extraction.provider", "off");
    settings.set(db, "extraction.model.claude", "claude-opus-4-6");
    const title = vi.spyOn(TextGenerator.prototype, "title").mockResolvedValue("CSV export filters");
    await expect(service.title({ request: "Add CSV", reply: "Done" }, "codex")).resolves.toBe("CSV export filters");
    expect(title).toHaveBeenCalledWith({ request: "Add CSV", reply: "Done" });
    expect(settings.get(db, "extraction.provider")).toBe("off");
    expect(settings.get(db, "extraction.model.claude")).toBe("claude-opus-4-6");
  });

  it("does not launch when off, logged out, or the selected binary is unavailable", async () => {
    const { providers, service } = fixture({ claude: false, codex: false, opencode: false });
    const title = vi.spyOn(TextGenerator.prototype, "title");
    expect((await service.updateSettings({ provider: "codex" })).reason).toMatch(/unavailable/);
    await expect(service.title({ request: "Export", reply: null }, "codex")).resolves.toBeNull();
    await service.updateSettings({ provider: "off" });
    vi.mocked(providers.loggedIn).mockClear();
    await expect(service.title({ request: "Export", reply: null }, "codex")).resolves.toBeNull();
    expect(providers.loggedIn).not.toHaveBeenCalled();
    vi.mocked(providers.loggedIn).mockResolvedValue({ claude: true, codex: true, opencode: false });
    vi.mocked(providers.launch).mockReturnValue(null);
    expect((await service.updateSettings({ provider: "claude" })).resolved).toBeNull();
    expect(title).not.toHaveBeenCalled();
  });
});
