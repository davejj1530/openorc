import { standIn, type StandIn } from "@openorc/hosted/testing";
import type { AccountStatus } from "@openorc/protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenOrc } from "../openorc.js";
import { rpcClient } from "../rpc-test-client.js";
import type { ProtectedSecretStore } from "../services/extraction-credentials.js";

const EMAIL = "ada@example.com";

let stand: StandIn;
let folder: string;
let stored: string | null;
let pushed: unknown[] = [];
let core: OpenOrc | null = null;
const call = rpcClient(() => core!);

/** Main's protected store for this profile, which outlives the core as the encrypted file does. */
const accountSecrets: ProtectedSecretStore = {
  load: async () => stored,
  save: async (value) => void (stored = value),
};

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  folder = await mkdtemp(path.join(tmpdir(), "openorc-account-"));
  stored = null;
  pushed = [];
});

afterEach(async () => {
  await core?.close();
  core = null;
  await stand.close();
  await rm(folder, { recursive: true, force: true });
});

async function open(options: { accountServer?: string; openBrowser?: (url: string) => void } = { accountServer: stand.url }) {
  core = await OpenOrc.create({ dataDir: path.join(folder, "data"), ephemeral: true, transport: { push: (push) => void pushed.push(push) }, accountSecrets, ...options });
  return core;
}

async function signIn(): Promise<AccountStatus> {
  await call("account.sendCode", { email: EMAIL });
  return call("account.signIn", { email: EMAIL, code: stand.codeFor(EMAIL)! });
}

describe("the OpenOrc account in the core", () => {
  it("is signed out on a new profile", async () => {
    await open();
    expect(await call("account.status", {})).toEqual({ state: "signed-out", codeSentTo: null, ended: false, error: null });
  });

  it("stays signed in across closing the core and opening it on the same profile", async () => {
    await open();
    expect(await signIn()).toMatchObject({ state: "signed-in", email: EMAIL });
    await vi.waitFor(async () => expect(await call("account.status", {})).toMatchObject({ reach: "live" }), { timeout: 5_000 });
    await core!.close();
    await open();
    await vi.waitFor(async () => expect(await call("account.status", {})).toMatchObject({ state: "signed-in", email: EMAIL, reach: "live" }), { timeout: 5_000 });
    expect(stand.requests.filter((request) => request.path === "/billing").every((request) => request.authorized)).toBe(true);
    expect(await call("account.signOut", {})).toMatchObject({ state: "signed-out", ended: false });
    expect(stored).toBe("");
  });

  it("answers signed out and refuses to sign in, in words, with no account server", async () => {
    await open({});
    expect(await call("account.status", {})).toEqual({ state: "signed-out", codeSentTo: null, ended: false, error: null });
    await expect(call("account.sendCode", { email: EMAIL })).rejects.toThrow("OpenOrc accounts aren't available here.");
    await expect(call("account.signIn", { email: EMAIL, code: "123456" })).rejects.toThrow("OpenOrc accounts aren't available here.");
    expect(stand.requests).toEqual([]);
  });

  it("makes no request and opens no socket for a profile nobody signed in on, at start or while Settings is open", async () => {
    const opened = await open();
    for (let read = 0; read < 5; read++) expect(await call("account.status", {})).toMatchObject({ state: "signed-out" });
    opened.account!.awoke();
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(await call("account.status", {})).toMatchObject({ state: "signed-out" });
    expect(stand.requests).toEqual([]);
  });

  it("chooses where cloud threads run and answers the whole status", async () => {
    await stand.close();
    stand = await standIn({ signup: "open", services: ["vercel", "agent37"] });
    await open();
    expect(await signIn()).toMatchObject({ name: "Ada", sandbox: { chosen: null, fallback: "vercel" } });
    expect(await call("account.setSandbox", { service: "agent37" })).toMatchObject({ state: "signed-in", sandbox: { chosen: "agent37" } });
    await expect(call("account.setSandbox", { service: "local" })).rejects.toThrow("This server doesn't run threads on this machine.");
  });
});

describe("agent sign-ins on OpenOrc Cloud through the core", () => {
  it("hands an agent's key to the server and answers the account with it, and says a refused one in the vendor's words", async () => {
    await open();
    await signIn();
    await expect(call("account.signIns.connect", { way: "key", agent: "codex", key: "bad-key" })).rejects.toThrow("OpenAI refused that API key.");
    const status = await call("account.signIns.connect", { way: "key", agent: "opencode", provider: "openrouter", key: "sk-or-good" });
    expect(status).toMatchObject({ state: "signed-in", signIns: [{ agent: "opencode", provider: "openrouter" }], signingIn: {} });
    expect(JSON.stringify(status)).not.toContain("sk-or-good");
  });
});

describe("paying through the core", () => {
  it("opens a checkout in the browser, never in a window, and answers Pro once the server says it was paid", async () => {
    const browser: string[] = [];
    await open({ accountServer: stand.url, openBrowser: (url) => void browser.push(url) });
    await signIn();
    expect(await call("account.billing.open", { page: "pro", period: "monthly" })).toMatchObject({ state: "signed-in", plan: { pro: false }, paying: { page: "pro" } });
    expect(browser).toEqual([stand.checkouts[0]!.url]);
    stand.pay(EMAIL);
    await vi.waitFor(async () => expect(await call("account.status", {})).toMatchObject({ plan: { pro: true }, paying: null }), { timeout: 5_000 });
    expect(JSON.stringify(pushed)).not.toContain(stand.checkouts[0]!.url);
    await expect(call("account.billing.open", { page: "pro", period: "yearly" })).rejects.toThrow("You already pay for Pro. Change your plan in billing.");
    expect(await call("account.billing.open", { page: "billing" })).toMatchObject({ paying: { page: "billing" } });
    expect(await call("account.billing.leave", {})).toMatchObject({ paying: null });
  });

  it("answers what Pro and a pack cost while signed in, and nothing signed out or with no account server", async () => {
    await open();
    expect(await call("account.offers", {})).toBeNull();
    await signIn();
    expect(await call("account.offers", {})).toMatchObject({ pro: [{ period: "monthly", price: { amount: 2000, currency: "usd" } }, { period: "yearly" }], hours: { months: 12 } });
    await core!.close();
    await open({});
    expect(await call("account.offers", {})).toBeNull();
  });
});
