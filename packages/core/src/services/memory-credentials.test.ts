import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Db, settings } from "@openorc/db";
import { MemoryService, type ProviderInfo } from "./memory.js";
import { extractionStorageError, type ProtectedSecretStore } from "./extraction-credentials.js";

const databases = new Set<Db>();
const folders: string[] = [];
const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
function fixture(db = Db.memory()) {
  databases.add(db);
  settings.set(db, "memory.enabled", "true");
  let saved: string | null = null;
  const secrets: ProtectedSecretStore = {
    load: vi.fn(async () => saved),
    save: vi.fn(async (value) => {
      saved = value;
    }),
  };
  const providers: ProviderInfo = {
    loggedIn: async () => ({ claude: true, codex: true, opencode: false }),
    models: async () => [],
    launch: (agent) => ({ revision: 1, binary: agent, env: Object.freeze({ PATH: "/fixture" }) }),
  };
  const make = (database = db) => new MemoryService(database, { dataDir: "/tmp", secrets }, providers, () => {}, silent);
  return { db, secrets, providers, make, memory: make() };
}
afterEach(async () => {
  for (const db of databases) db.close();
  databases.clear();
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("memory credential integration", () => {
  it("keeps the protected key, off and model preferences after database reopen, with no key in SQLite", async () => {
    const folder = await mkdtemp(join(tmpdir(), "openorc-memory-key-"));
    folders.push(folder);
    const file = join(folder, "fixture.sqlite");
    const { db, memory, make } = fixture(Db.open(file));
    settings.set(db, "extraction.provider", "off");
    settings.set(db, "extraction.model.claude", "chosen-model-fixture");
    await memory.updateSettings({ apiKey: "key-fixture" });
    expect(await memory.settings()).toMatchObject({ provider: "off", hasApiKey: true, resolved: null, reason: null });
    expect(settings.get(db, "extraction.apiKey")).toBeNull();
    db.close();
    databases.delete(db);
    const reopened = Db.open(file);
    databases.add(reopened);
    const restarted = make(reopened);
    expect(await restarted.settings()).toMatchObject({ provider: "off", hasApiKey: true, resolved: null });
    expect(await restarted.extractor("claude")).toBeNull();
    expect(await restarted.updateSettings({ provider: "apikey" })).toMatchObject({ model: "chosen-model-fixture", resolved: { viaApiKey: true } });
  });

  it("disables API-key extraction on storage failure while off and subscriptions remain usable", async () => {
    const { secrets, memory } = fixture();
    await memory.updateSettings({ apiKey: "key-fixture" });
    vi.mocked(secrets.load).mockRejectedValue(new Error("OS error includes key-fixture"));
    const failed = await memory.updateSettings({ provider: "apikey" });
    expect(failed).toMatchObject({ hasApiKey: false, resolved: null, reason: extractionStorageError, apiKeyError: extractionStorageError });
    expect(JSON.stringify(failed)).not.toContain("key-fixture");
    expect(await memory.extractor("claude")).toBeNull();
    expect(await memory.updateSettings({ provider: "claude" })).toMatchObject({ resolved: { provider: "claude", viaApiKey: false }, reason: null });
    expect(await memory.extractor("claude")).not.toBeNull();
    expect(await memory.updateSettings({ provider: "auto" })).toMatchObject({ resolved: null, automatic: [{ provider: "claude", viaApiKey: false }] });
    expect(await memory.updateSettings({ provider: "off" })).toMatchObject({ resolved: null, reason: null });
    expect(JSON.stringify(silent.warn.mock.calls)).not.toContain("key-fixture");
  });

  it("does not partially change the provider/model after a failed key save", async () => {
    const { db, secrets, memory } = fixture();
    await memory.updateSettings({ provider: "off" });
    vi.mocked(secrets.save).mockRejectedValueOnce(new Error("contains new-fixture"));
    await expect(memory.updateSettings({ provider: "apikey", model: "chosen-fixture", apiKey: "new-fixture" })).rejects.toThrow(extractionStorageError);
    expect(settings.get(db, "extraction.provider")).toBe("off");
    expect(settings.get(db, "extraction.model.claude")).toBeNull();
    expect(settings.get(db, "extraction.apiKey")).toBeNull();
    expect(await memory.updateSettings({ provider: "apikey", apiKey: "new-fixture" })).toMatchObject({ hasApiKey: true, resolved: { viaApiKey: true } });
  });

  it("orders complete settings patches so provider, model, and key stay together", async () => {
    const { memory, db } = fixture();
    const first = memory.updateSettings({ provider: "apikey", model: "first-fixture", apiKey: "first-key-fixture" });
    const second = memory.updateSettings({ provider: "claude", model: "second-fixture", apiKey: "second-key-fixture" });
    const read = memory.settings();
    expect(await first).toMatchObject({ provider: "apikey", model: "first-fixture", resolved: { viaApiKey: true } });
    expect(await second).toMatchObject({ provider: "claude", model: "second-fixture", resolved: { viaApiKey: false } });
    expect(await read).toMatchObject({ provider: "claude", model: "second-fixture" });
    expect(settings.get(db, "extraction.apiKey")).toBeNull();
  });

  it("uses a protected key only when chosen, and stops using it after clearing", async () => {
    const { providers, memory, make } = fixture();
    providers.loggedIn = async () => ({ claude: false, codex: false, opencode: false });
    const saved = await memory.updateSettings({ apiKey: "protected-fixture" });
    expect(saved).toMatchObject({ provider: "auto", hasApiKey: true, resolved: null, automatic: [] });
    expect(JSON.stringify(saved)).not.toContain("protected-fixture");
    expect(await make().extractor("codex")).toBeNull();
    expect(await memory.updateSettings({ provider: "apikey" })).toMatchObject({ resolved: { provider: "claude", viaApiKey: true } });
    expect(await make().extractor("codex")).not.toBeNull();
    expect(await memory.updateSettings({ apiKey: "" })).toMatchObject({ hasApiKey: false, resolved: null });
    expect(await make().extractor("codex")).toBeNull();
  });
});
