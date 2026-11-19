import { hostedRunId, hostedSendBlock, type AccountStatus, type AgentEvent } from "@openorc/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { CLOUD_PROJECT } from "./translate.js";
import { hostDeps, newDevice, signInAs, type Device } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

/*
 * A cloud thread's account, behind the server's `agentAccounts`: the person chooses which of their accounts its next
 * turns run on, a new thread starts on one, the thread reads it back, and a turn the server refuses on a signed-out
 * account marks that account, not the default.
 */
const ADA = "ada@example.com";
const SPACE = `personal-${ADA}`;
const SETTINGS = { agent: "claude", model: "opus", mode: "act", permissionMode: "trusted" } as const;

let stand: StandIn;
let device: Device;
const hosts: Hosted[] = [];

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  device = newDevice();
  stand.setBilling(ADA, { pro: true, standing: "live", at: new Date(Date.now() + 20 * 86_400_000).toISOString(), monthlyLeftSeconds: 3600, packsLeftSeconds: 0 });
  stand.setSignIns(ADA, [
    { agent: "claude", label: "Claude Max", id: "personal", name: "Personal", isDefault: true },
    { agent: "claude", label: "Claude Max", id: "work", name: "Work", isDefault: false },
  ]);
  stand.threadFiles.capabilities = { agentAccounts: { available: true } };
});

afterEach(async () => {
  for (const hosted of hosts.splice(0)) hosted.close();
  await stand.close();
});

async function withThread() {
  const project = stand.addProject(ADA, { name: "openorc", fullName: "acme/openorc" });
  const thread = stand.addThread(ADA, { projectId: project, title: "Export the activity log" });
  const { deps, browser } = hostDeps(stand, device);
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, ADA);
  await vi.waitFor(() => expect(hosted.threads.holds({ thread })).toBe(true));
  await vi.waitFor(() => expect(status(hosted).signIns).not.toBeNull());
  await hosted.spaces.refresh();
  return { hosted, thread, project };
}

function status(hosted: Hosted): Extract<AccountStatus, { state: "signed-in" }> {
  const now = hosted.account.status();
  if (now.state !== "signed-in") throw new Error("signed out");
  return now;
}

const row = async (hosted: Hosted, thread: string) => (await hosted.threads.call("threads.get", { id: thread }))!;

it("runs a thread's next turns on the account the person chooses, read back from the thread, and back on the default", async () => {
  const { hosted, thread } = await withThread();
  expect((await row(hosted, thread)).cloudAccountId).toBeUndefined();
  expect(await hosted.threads.call("threads.update", { id: thread, patch: { cloudAccountId: "work" } })).toMatchObject({ cloudAccountId: "work" });
  await hosted.threads.call("threads.update", { id: thread, patch: { cloudAccountId: null } });
  expect((await row(hosted, thread)).cloudAccountId).toBeNull();
});

it("starts a new cloud thread on the account chosen", async () => {
  const { hosted } = await withThread();
  const added = stand.addProject(ADA, { name: "site", fullName: "acme/site" });
  const made = await hosted.threads.call("threads.start", { projectId: `${CLOUD_PROJECT}${added}`, spaceId: SPACE, prompt: "Start the site", cloudAccountId: "work", ...SETTINGS });
  expect(stand.started.at(-1)!.body["settings"]).toMatchObject({ agent: "claude", accountId: "work" });
  expect(made.thread.cloudAccountId).toBe("work");
});

it("marks the account a refused turn named as signed out, and holds the next send there while the default still sends", async () => {
  stand.setSignIns(ADA, [
    { agent: "claude", label: "Claude Max", id: "personal", name: "Personal", isDefault: true },
    { agent: "claude", label: "Claude Max", id: "work", name: "Work", isDefault: false, ended: true },
  ]);
  const { hosted, thread } = await withThread();
  await hosted.threads.call("threads.update", { id: thread, patch: { cloudAccountId: "work" } });
  await expect(hosted.threads.call("runs.start", { threadId: thread, ...SETTINGS, prompt: "Export it" })).rejects.toThrow();
  await vi.waitFor(() =>
    expect(status(hosted).signIns!.map(({ id, ended }) => ({ id, ended }))).toEqual([
      { id: "personal", ended: false },
      { id: "work", ended: true },
    ]),
  );
  expect(hostedSendBlock(status(hosted), { agent: "claude", model: "opus", accountId: "work" }, false)).toBe("signed_out");
  expect(hostedSendBlock(status(hosted), { agent: "claude", model: "opus" }, false)).toBeNull();
  // A teammate's account is not the person's: their turn runs on their own default.
  expect(hostedSendBlock(status(hosted), { agent: "claude", model: "opus", accountId: "someone-elses" }, false)).toBeNull();
});

it("shows its sender the line a thread writes when it goes on with another account at a limit, and runs on that account", async () => {
  const { hosted, thread } = await withThread();
  stand.switchedAtLimit(thread, ADA, { agent: "Claude", from: "Personal", to: "Work", toId: "work" });
  const lines = async () =>
    (await hosted.threads.call("events.page", { runId: hostedRunId(thread), turns: 10 })).events.flatMap((event: AgentEvent) =>
      event.type === "message.completed" && event.role === "system" ? [event.text] : [],
    );
  await vi.waitFor(async () => expect(await lines()).toEqual(["Moved to the Claude account Work after Personal reached its usage limit. Continue where you left off."]));
  await vi.waitFor(async () => expect((await row(hosted, thread)).cloudAccountId).toBe("work"));
});

it("goes on with another account at a limit unless the person turns it off, and says nothing of it on a server without accounts", async () => {
  const { hosted } = await withThread();
  await vi.waitFor(() => expect(status(hosted).switchAccountsAtLimit).toBe(true));
  await hosted.account.setSwitchAtLimit(false);
  expect(status(hosted).switchAccountsAtLimit).toBe(false);
  expect(status(hosted).sandbox).toMatchObject({ chosen: null });
  stand.threadFiles.capabilities = null;
  await hosted.account.setSandbox(null);
  expect(status(hosted).switchAccountsAtLimit).toBeUndefined();
});
