import { hostedRunId, hostedSendBlock, type AgentEvent } from "@openorc/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { hostDeps, newDevice, type Device } from "./test-fixtures/host.js";
import { standIn, type StandIn, type StandInBilling } from "./testing/stand-in.js";

const ADA = "ada@example.com";
const PRO: StandInBilling = { pro: true, standing: "live", at: new Date(Date.now() + 20 * 86_400_000).toISOString(), monthlyLeftSeconds: 3600, packsLeftSeconds: 0 };
const SETTINGS = { agent: "claude", model: "opus", mode: "act", permissionMode: "trusted" } as const;

let stand: StandIn;
let device: Device;
const hosts: Hosted[] = [];

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  device = newDevice();
  device.projects = [{ id: "mac-openorc", remote: "git@github.com:Altalogy/openorc.git" }];
  stand.setBilling(ADA, PRO);
  stand.setSignIns(ADA, [{ agent: "claude" }]);
});

afterEach(async () => {
  for (const hosted of hosts.splice(0)) hosted.close();
  await stand.close();
});

/** A signed-in host with one thread of the account's, heard. */
async function withThread(seed: { status?: "idle" | "working" } = {}, now: () => number = Date.now) {
  const project = stand.addProject(ADA, { name: "openorc", fullName: "altalogy/openorc" });
  const thread = stand.addThread(ADA, { projectId: project, title: "Retry the cloud start", ...seed });
  const { deps, seen } = hostDeps(stand, device, { now });
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await hosted.account.sendCode(ADA);
  await hosted.account.signIn(ADA, stand.codeFor(ADA)!);
  await vi.waitFor(() => expect(hosted.threads.holds({ thread })).toBe(true));
  await vi.waitFor(() => expect(signedIn(hosted).signIns).not.toBeNull());
  return { hosted, thread, run: hostedRunId(thread), seen };
}

function signedIn(hosted: Hosted) {
  const status = hosted.account.status();
  if (status.state !== "signed-in") throw new Error("signed out");
  return status;
}

const row = async (hosted: Hosted, thread: string) => (await hosted.threads.call("threads.get", { id: thread }))!;
const said = async (hosted: Hosted, run: string) =>
  (await hosted.threads.call("events.page", { runId: run, turns: 10 })).events.flatMap((event: AgentEvent) =>
    event.type === "message.completed" && event.role === "user" ? [`${event.messageId}: ${event.text}`] : [],
  );
const start = (hosted: Hosted, thread: string, messageId: string) => hosted.threads.call("runs.start", { threadId: thread, ...SETTINGS, prompt: "Find why the first message waits", messageId });

describe("sending to an OpenOrc Cloud thread", () => {
  it("starts a turn under the window's own id, so its bubble is the stored message and a retry is the same message", async () => {
    const { hosted, thread, run } = await withThread();
    const id = `user-${crypto.randomUUID()}`;
    expect(await start(hosted, thread, id)).toMatchObject({ id: run, state: "running" });
    expect(await row(hosted, thread)).toMatchObject({ activity: "running" });
    await start(hosted, thread, id);
    expect(await said(hosted, run)).toEqual([`${id}: Find why the first message waits`]);
  });

  it("steers a running turn without asking for the sender's hours, which the turn's starter pays", async () => {
    const { hosted, run } = await withThread({ status: "working" });
    stand.setBilling(ADA, { pro: false });
    await hosted.threads.call("runs.send", { runId: run, text: "Check the sleeping case too", messageId: `user-${crypto.randomUUID()}` });
    expect((await said(hosted, run)).map((line) => line.split(": ")[1])).toEqual(["Check the sleeping case too"]);
  });

  it.each([
    { why: "not_pro", words: "OpenOrc Cloud needs Pro.", arrange: () => stand.setBilling(ADA, { pro: false }) },
    { why: "no_hours", words: "You're out of cloud hours.", arrange: () => stand.setBilling(ADA, { ...PRO, monthlyLeftSeconds: 0 }) },
    { why: "awaiting_payment", words: "Your payment hasn't gone through.", arrange: () => stand.setBilling(ADA, { ...PRO, monthlyLeftSeconds: null }) },
    { why: "no_sign_in", words: "Claude isn't signed in on OpenOrc Cloud.", arrange: () => stand.setSignIns(ADA, [{ agent: "codex" }]) },
    { why: "signed_out", words: "Claude's sign-in on OpenOrc Cloud ended.", arrange: () => stand.setSignIns(ADA, [{ agent: "claude", ended: true }]) },
  ])("refuses a send the server refuses ($why) in its words, stores nothing, and reads the account again", async ({ why, words, arrange }) => {
    const { hosted, thread, run } = await withThread();
    arrange();
    await expect(start(hosted, thread, `user-${crypto.randomUUID()}`)).rejects.toThrow(words);
    expect(await said(hosted, run)).toEqual([]);
    await vi.waitFor(() => expect(hostedSendBlock(hosted.account.status(), SETTINGS, false)).toBe(why));
  });

  it("holds a message for after the running turn in the queue, then sends it when the turn ends", async () => {
    const { hosted, thread, run } = await withThread({ status: "working" });
    const queued = await hosted.threads.call("threads.queue", { id: thread, text: "Then open a pull request", requestKey: crypto.randomUUID() });
    expect(queued).toMatchObject([{ text: "Then open a pull request", error: null }]);
    expect(await said(hosted, run)).toEqual([]);
    stand.endTurn(thread);
    await vi.waitFor(async () => expect((await row(hosted, thread)).queued).toEqual([]));
    expect((await said(hosted, run)).map((line) => line.split(": ")[1])).toEqual(["Then open a pull request"]);
  });

  it("keeps a waiting message the server refused later in the queue with the words, and tries it again", async () => {
    const { hosted, thread, run } = await withThread({ status: "working" });
    await hosted.threads.call("threads.queue", { id: thread, text: "Then open a pull request", requestKey: crypto.randomUUID() });
    stand.setBilling(ADA, { ...PRO, monthlyLeftSeconds: 0 });
    stand.endTurn(thread);
    await vi.waitFor(async () => expect((await row(hosted, thread)).queued).toMatchObject([{ text: "Then open a pull request", error: "You're out of cloud hours." }]));
    const [refused] = (await row(hosted, thread)).queued;
    await expect(hosted.threads.call("threads.sendQueued", { id: thread, messageId: refused!.id })).rejects.toThrow("You're out of cloud hours.");
    stand.setBilling(ADA, PRO);
    expect(await hosted.threads.call("threads.sendQueued", { id: thread, messageId: refused!.id })).toEqual([]);
    expect((await said(hosted, run)).map((line) => line.split(": ")[1])).toEqual(["Then open a pull request"]);
  });

  it("takes a message out of the queue, and Stop ends the turn and cancels what waits", async () => {
    const { hosted, thread, run } = await withThread({ status: "working" });
    const [first] = await hosted.threads.call("threads.queue", { id: thread, text: "First", requestKey: crypto.randomUUID() });
    expect(await hosted.threads.call("threads.unqueue", { id: thread, messageId: first!.id })).toEqual([]);
    await hosted.threads.call("threads.queue", { id: thread, text: "Second", requestKey: crypto.randomUUID() });
    await hosted.threads.call("runs.interrupt", { runId: run });
    expect(await row(hosted, thread)).toMatchObject({ activity: "idle", queued: [] });
    expect(await said(hosted, run)).toEqual([]);
  });

  it("refuses in words what a cloud thread does not take", async () => {
    const { hosted, thread } = await withThread();
    await expect(hosted.threads.call("threads.fork", { id: thread })).rejects.toThrow("This isn't on OpenOrc Cloud yet.");
    await expect(hosted.threads.call("git.threadLog", { threadId: thread })).rejects.toThrow("An OpenOrc Cloud thread's files aren't on this Mac.");
  });

  it("refuses files in words until the server takes them", async () => {
    const { hosted, run } = await withThread({ status: "working" });
    await expect(hosted.threads.call("runs.send", { runId: run, text: "See this", attachments: ["/tmp/shot.png"] })).rejects.toThrow("Files can't be sent to OpenOrc Cloud yet.");
  });
});

describe("what the composer saves as the person writes", () => {
  it("keeps the draft on this device, through a restart, and sends the chosen model with the next message", async () => {
    const { hosted, thread, run } = await withThread({ status: "working" });
    await hosted.threads.call("threads.update", { id: thread, patch: { draft: "Half a thought", model: "sonnet" } });
    expect(await row(hosted, thread)).toMatchObject({ draft: "Half a thought", model: "sonnet" });
    hosted.close();
    const { deps } = hostDeps(stand, device);
    const again = createHosted(deps);
    hosts.push(again);
    await again.start();
    expect(again.threads.listed("threads.list", { projectIds: ["mac-openorc"] })?.rows[0]).toMatchObject({ draft: "Half a thought", model: "sonnet" });
    await again.threads.call("runs.send", { runId: run, text: "Go on", messageId: `user-${crypto.randomUUID()}` });
    expect(stand.sent.at(-1)?.body).toMatchObject({ text: "Go on", settings: { model: "sonnet" } });
  });

  it("marks the thread read on the server, and refuses what waits for the server in words", async () => {
    const { hosted, thread } = await withThread();
    stand.append(thread, [{ type: "message.completed", ts: 1, messageId: "a1", role: "assistant", text: "Done" }]);
    await vi.waitFor(async () => expect(await row(hosted, thread)).toMatchObject({ unread: true }));
    await hosted.threads.call("threads.update", { id: thread, patch: { seen: true } });
    expect(await row(hosted, thread)).toMatchObject({ unread: false });
    await expect(hosted.threads.call("threads.update", { id: thread, patch: { title: "Renamed" } })).rejects.toThrow("This isn't on OpenOrc Cloud yet.");
  });
});

describe("an OpenOrc Cloud thread's asks", () => {
  it("stay open after their turn parks, and an answer through the server closes them and goes on", async () => {
    const { hosted, thread, run } = await withThread({ status: "working" });
    const ask = stand.ask(thread, { kind: "command", toolName: "Bash", input: { command: "pnpm build" }, detail: "Bash: pnpm build" });
    stand.endTurn(thread);
    await vi.waitFor(async () => expect(await row(hosted, thread)).toMatchObject({ activity: "waiting" }));
    const page = await hosted.threads.call("events.page", { runId: run, turns: 4 });
    expect(page.events.find((event) => event.type === "approval.requested")).toMatchObject({ approvalId: ask, durable: true });
    // Parked, the ask waits on nothing running: the run is not live, so the composer sends rather than queues or stops.
    expect(page.live).toBe(false);
    expect(await hosted.threads.call("runs.listForThread", { threadId: thread })).toMatchObject([{ state: "success" }]);
    await hosted.threads.call("approvals.resolve", { runId: run, approvalId: ask, decision: "allow" });
    expect(await row(hosted, thread)).toMatchObject({ activity: "running" });
  });

  it("refuses an answer that would start a turn the person cannot start, and the ask stays open", async () => {
    const { hosted, thread, run } = await withThread({ status: "working" });
    const ask = stand.ask(thread, { kind: "user_input", input: { questions: [] }, detail: "Which branch?" });
    stand.endTurn(thread);
    stand.setBilling(ADA, { ...PRO, monthlyLeftSeconds: 0 });
    await expect(hosted.threads.call("approvals.resolve", { runId: run, approvalId: ask, decision: "allow", answers: { q: ["main"] } })).rejects.toThrow("You're out of cloud hours.");
    expect(await row(hosted, thread)).toMatchObject({ activity: "waiting" });
  });
});

describe("making a thread ready before the message", () => {
  it("asks once a minute at most while the person writes", async () => {
    const clock = { now: Date.now() };
    const { hosted, thread } = await withThread({}, () => clock.now);
    await hosted.threads.call("threads.ready", { id: thread });
    await hosted.threads.call("threads.ready", { id: thread, settings: { model: "sonnet" } });
    expect(stand.readies).toEqual([{ threadId: thread, settings: null }]);
    clock.now += 61_000;
    await hosted.threads.call("threads.ready", { id: thread, settings: { model: "sonnet" } });
    expect(stand.readies).toEqual([
      { threadId: thread, settings: null },
      { threadId: thread, settings: { model: "sonnet" } },
    ]);
  });

  it("never asks for a working thread, which is ready already, or one the account says cannot start a turn", async () => {
    const working = await withThread({ status: "working" });
    await working.hosted.threads.call("threads.ready", { id: working.thread });
    stand.setBilling(ADA, { pro: false });
    const free = await withThread();
    await free.hosted.threads.call("threads.ready", { id: free.thread });
    expect(stand.requests.filter((request) => request.path.endsWith("/ready"))).toEqual([]);
  });
});
