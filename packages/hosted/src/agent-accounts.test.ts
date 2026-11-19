import type { AccountStatus } from "@openorc/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted, type HostedDeps } from "./index.js";
import { hostDeps, newDevice, signInAs } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

/*
 * Several accounts per agent on OpenOrc Cloud, behind the server's `agentAccounts`: each way of signing in adds a new
 * account or signs one in again, the person renames one or makes it the default, and removes one. A server without
 * the capability keeps one sign-in per agent, as before.
 */
const ADA = "ada@example.com";
const TOKEN = "sk-ant-oat01-made-on-this-mac-0123456789abcdef";

let stand: StandIn;
const hosts: Hosted[] = [];

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  stand.setBilling(ADA, { pro: true, standing: "live", at: new Date(Date.now() + 20 * 86_400_000).toISOString(), monthlyLeftSeconds: 3600, packsLeftSeconds: 0 });
  stand.threadFiles.capabilities = { agentAccounts: { available: true } };
});

afterEach(async () => {
  for (const hosted of hosts.splice(0)) hosted.close();
  await stand.close();
});

async function signedIn(overrides: Partial<HostedDeps> = {}): Promise<Hosted> {
  const { deps, browser } = hostDeps(stand, newDevice(), overrides);
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, ADA);
  await vi.waitFor(() => expect(status(hosted).signIns).not.toBeNull());
  return hosted;
}

function status(hosted: Hosted): Extract<AccountStatus, { state: "signed-in" }> {
  const now = hosted.account.status();
  if (now.state !== "signed-in") throw new Error("signed out");
  return now;
}

const claudeAccounts = (hosted: Hosted) =>
  status(hosted)
    .signIns!.filter((row) => row.agent === "claude")
    .map(({ name, label, isDefault }) => ({ name, label, isDefault }));

it("adds each Claude sign-in as a new account, the first the default, named by its plan or by the person", async () => {
  const mintClaudeToken = () => ({ token: Promise.resolve(TOKEN), cancel: () => {} });
  const hosted = await signedIn({ mintClaudeToken });
  // With no sign-in yet nothing tells the servers apart, and the first sign-in is the default account on either.
  expect(status(hosted).agentAccounts).toBe(false);
  await hosted.account.connectSignIn({ way: "token", agent: "claude" });
  await vi.waitFor(() => expect(claudeAccounts(hosted)).toHaveLength(1));
  expect(status(hosted).agentAccounts).toBe(true);
  await hosted.account.connectSignIn({ way: "token", agent: "claude", name: "Work" });
  await vi.waitFor(() => expect(claudeAccounts(hosted)).toHaveLength(2));
  await hosted.account.connectSignIn({ way: "key", agent: "claude", key: "sk-ant-api-key" });
  await hosted.account.connectSignIn({ way: "key", agent: "claude", key: "sk-ant-api-key-2" });
  expect(claudeAccounts(hosted)).toEqual([
    { name: "Claude Max", label: "Claude Max", isDefault: true },
    { name: "Work", label: "Claude Max", isDefault: false },
    { name: "API key", label: "API key", isDefault: false },
    { name: "API key 2", label: "API key", isDefault: false },
  ]);
  // Each signs in again the way it was made.
  expect(status(hosted).signIns!.map((row) => row.way)).toEqual(["token", "token", "key", "key"]);
});

it("signs an account in again in place, keeping its name and default, and says which account a sign-in under way is for", async () => {
  let finish: (token: string) => void = () => {};
  const mintClaudeToken = () => ({ token: new Promise<string>((resolve) => (finish = resolve)), cancel: () => {} });
  stand.setSignIns(ADA, [
    { agent: "claude", label: "Claude Max", name: "Personal", isDefault: true, id: "personal" },
    { agent: "claude", label: "Claude Max", name: "Work", isDefault: false, id: "work", ended: true },
  ]);
  const hosted = await signedIn({ mintClaudeToken });
  await hosted.account.connectSignIn({ way: "token", agent: "claude", accountId: "work" });
  expect(status(hosted).signingIn.claude).toEqual({ state: "waiting", way: "token", accountId: "work" });
  finish(TOKEN);
  await vi.waitFor(() => expect(status(hosted).signingIn).toEqual({}));
  expect(status(hosted).signIns!.map(({ id, name, isDefault }) => ({ id, name, isDefault }))).toEqual([
    { id: "personal", name: "Personal", isDefault: true },
    { id: "work", name: "Work", isDefault: false },
  ]);
  expect(stand.signInSecrets).toEqual([{ agent: "claude", secret: TOKEN }]);
});

it("adds a Codex account by device code under its name, or signs one in again", async () => {
  stand.setSignIns(ADA, [{ agent: "codex", provider: "openai", label: "ChatGPT Plus", id: "first", name: "ChatGPT Plus", isDefault: true }]);
  const hosted = await signedIn();
  await hosted.account.connectSignIn({ way: "code", agent: "codex", name: "Team" });
  expect(status(hosted).signingIn.codex).toMatchObject({ state: "waiting", way: "code" });
  stand.approveDevice(ADA);
  // The app asks the server to finish at the pace it gave, a second here.
  await vi.waitFor(
    () =>
      expect(
        status(hosted)
          .signIns!.filter((row) => row.agent === "codex")
          .map((row) => row.name),
      ).toEqual(["ChatGPT Plus", "Team"]),
    { timeout: 5000 },
  );
  await hosted.account.connectSignIn({ way: "code", agent: "codex", accountId: "first" });
  expect(status(hosted).signingIn.codex).toMatchObject({ state: "waiting", way: "code", accountId: "first" });
  stand.approveDevice(ADA);
  await vi.waitFor(() => expect(status(hosted).signingIn).toEqual({}), { timeout: 5000 });
  expect(status(hosted).signIns!.filter((row) => row.agent === "codex")).toHaveLength(2);
});

it("renames an account and makes another the default, and refuses an empty name in the server's words", async () => {
  stand.setSignIns(ADA, [
    { agent: "claude", label: "Claude Max", id: "personal", name: "Claude Max", isDefault: true },
    { agent: "claude", label: "Claude Max", id: "work", name: "Claude Max 2" },
  ]);
  const hosted = await signedIn();
  await hosted.account.updateSignIn({ accountId: "work", name: "Work" });
  await hosted.account.updateSignIn({ accountId: "work", isDefault: true });
  expect(claudeAccounts(hosted)).toEqual([
    { name: "Claude Max", label: "Claude Max", isDefault: false },
    { name: "Work", label: "Claude Max", isDefault: true },
  ]);
  await expect(hosted.account.updateSignIn({ accountId: "nobody", name: "Lost" })).rejects.toThrow("That account isn't here.");
});

it("removes an account, the oldest left becoming the default, and keeps one a turn runs on, in the server's words", async () => {
  stand.setSignIns(ADA, [
    { agent: "claude", label: "Claude Max", id: "personal", name: "Personal", isDefault: true },
    { agent: "claude", label: "Claude Max", id: "work", name: "Work" },
    { agent: "claude", label: "API key", id: "key", name: "Key" },
  ]);
  const hosted = await signedIn();
  stand.busyAccounts.add("key");
  await expect(hosted.account.removeSignIn({ agent: "claude", accountId: "key" })).rejects.toThrow("A turn is running on this account.");
  await hosted.account.removeSignIn({ agent: "claude", accountId: "personal" });
  expect(claudeAccounts(hosted)).toEqual([
    { name: "Work", label: "Claude Max", isDefault: true },
    { name: "Key", label: "API key", isDefault: false },
  ]);
});

it("names the account of each usage reading", async () => {
  stand.agentUsage.readings.set(ADA, [{ agent: "claude", accountId: "work", readAt: new Date().toISOString(), reading: { five_hour: { utilization: 40 } } }]);
  const hosted = await signedIn();
  expect(await hosted.account.agentUsage()).toMatchObject([{ agent: "claude", accountId: "work" }]);
});

it("keeps one sign-in per agent on a server without accounts, as before", async () => {
  stand.threadFiles.capabilities = null;
  stand.setSignIns(ADA, [{ agent: "claude", label: "Claude Max" }]);
  const hosted = await signedIn();
  expect(status(hosted).agentAccounts).toBe(false);
  expect(status(hosted).signIns).toEqual([{ agent: "claude", provider: "anthropic", label: "Claude Max", ended: false }]);
  await hosted.account.connectSignIn({ way: "key", agent: "claude", key: "sk-ant-api-key", name: "Ignored" });
  expect(status(hosted).signIns).toEqual([{ agent: "claude", provider: "anthropic", label: "API key", ended: false }]);
  expect(stand.requests.some((request) => request.path.startsWith("/agent-sign-ins/accounts"))).toBe(false);
});
