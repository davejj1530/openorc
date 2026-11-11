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
});

afterEach(async () => {
  await core?.close();
  core = null;
  await stand.close();
  await rm(folder, { recursive: true, force: true });
});

async function open(options: { accountServer?: string } = { accountServer: stand.url }) {
  core = await OpenOrc.create({ dataDir: path.join(folder, "data"), ephemeral: true, transport: { push() {} }, accountSecrets, ...options });
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
});
