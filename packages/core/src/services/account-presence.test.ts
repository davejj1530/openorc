import { standIn, type StandIn } from "@openorc/hosted/testing";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OpenOrc } from "../openorc.js";
import { rpcClient } from "../rpc-test-client.js";
import type { ProtectedSecretStore } from "./extraction-credentials.js";

/*
 * Before OpenOrc Cloud alerts the person's phone, it asks their own computers whether someone is at one. The Mac answers
 * with the reading its own phone alerts hold back by, over its live socket.
 */
const EMAIL = "ada@example.com";
let stand: StandIn;
let folder: string;
let stored: string | null;
let core: OpenOrc | null = null;
const call = rpcClient(() => core!);
const accountSecrets: ProtectedSecretStore = { load: async () => stored, save: async (value) => void (stored = value) };

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  folder = await mkdtemp(path.join(tmpdir(), "openorc-presence-"));
  stored = null;
});
afterEach(async () => {
  await core?.close();
  core = null;
  await stand.close();
  await rm(folder, { recursive: true, force: true });
});

async function signedIn(presence?: () => Promise<boolean>) {
  const openBrowser = (url: string) => void (new URL(url).pathname === "/sign-in" && fetch(stand.signInPage(url, EMAIL)));
  core = await OpenOrc.create({ dataDir: path.join(folder, "data"), transport: { push: () => undefined }, accountSecrets, openBrowser, accountServer: stand.url, ...(presence && { presence }) });
  await call("account.signIn", {});
  await vi.waitFor(async () => expect(await call("account.status", {})).toMatchObject({ state: "signed-in", reach: "live" }), { timeout: 5_000 });
}

it("answers OpenOrc Cloud's ask before an alert with this Mac's own reading, each time it asks", async () => {
  let active = true;
  await signedIn(async () => active);
  expect(await stand.presence(EMAIL)).toBe(true);
  active = false;
  expect(await stand.presence(EMAIL)).toBe(false);
});

it("says at once that nobody is at a computer with no reading", async () => {
  await signedIn();
  const started = Date.now();
  expect(await stand.presence(EMAIL, 5_000)).toBe(false);
  expect(Date.now() - started).toBeLessThan(1_000);
});
