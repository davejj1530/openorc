import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settings } from "@openorc/db";
import type { CorePush } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";

let folder: string;
let core: OpenOrc;
const pushed: CorePush[] = [];
let stored: string | null;
let failSave: boolean;
let logging: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "openorc-key-rpc-"));
  stored = null;
  failSave = false;
  logging = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubEnv("OPENORC_RPC_LOG", "1");
  core = await OpenOrc.create({
    dataDir: folder,
    ephemeral: true,
    transport: { push: (message) => pushed.push(message) },
    memorySecrets: {
      load: async () => stored,
      save: async (value) => {
        if (failSave) throw new Error(`OS error with ${value}`);
        stored = value;
      },
    },
  });
  settings.set(core.db, "extraction.provider", "off");
  pushed.length = 0;
  logging.mockClear();
});
afterEach(async () => {
  await core?.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(folder, { recursive: true, force: true });
});
async function set(params: unknown) {
  await core.handle({ type: "rpc", id: 1, method: "memory.settings.set", params });
  return pushed.find((message) => (message.type === "rpc.result" || message.type === "rpc.error") && message.id === 1);
}
describe("memory credentials through RPC", () => {
  it.each([false, true])("never logs or returns a submitted key with diagnostic logging enabled (save fails: %s)", async (failure) => {
    failSave = failure;
    const reply = await set({ apiKey: "synthetic-rpc-secret-fixture" });
    expect(reply?.type).toBe(failure ? "rpc.error" : "rpc.result");
    expect(JSON.stringify(pushed)).not.toContain("synthetic-rpc-secret-fixture");
    expect(JSON.stringify(logging.mock.calls)).not.toContain("synthetic-rpc-secret-fixture");
    expect(settings.get(core.db, "extraction.apiKey")).toBeNull();
    if (!failure) expect(JSON.stringify(logging.mock.calls)).toContain("[private]");
  });

  it("does not echo secret-bearing malformed parameters", async () => {
    const reply = await set({ provider: "synthetic-malformed-secret-fixture", apiKey: ["synthetic-malformed-secret-fixture"] });
    expect(reply?.type).toBe("rpc.error");
    expect(JSON.stringify(pushed)).not.toContain("synthetic-malformed-secret-fixture");
    expect(JSON.stringify(logging.mock.calls)).not.toContain("synthetic-malformed-secret-fixture");
    expect(stored).toBeNull();
  });

  it("reflects saved, replaced, and cleared protected credentials in provider usage", async () => {
    await set({ apiKey: "saved-usage-fixture" });
    expect((await core.providerUsage.read("anthropic-api")).status).toBe("unavailable");
    expect(settings.get(core.db, "extraction.apiKey")).toBeNull();
    await set({ apiKey: "replacement-usage-fixture" });
    expect((await core.providerUsage.read("anthropic-api")).status).toBe("unavailable");
    await set({ apiKey: "" });
    expect((await core.providerUsage.read("anthropic-api")).status).toBe("disconnected");
    expect(JSON.stringify(pushed)).not.toMatch(/saved-usage-fixture|replacement-usage-fixture/);
  });
});
