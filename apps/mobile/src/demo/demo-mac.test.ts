import type { ClientPush } from "@openorc/client";
import { AgentEvent, FolderPath, Frame, Run, ThreadSummary } from "@openorc/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionManager } from "../connection/manager";
import { effectsFor, FakeMac } from "../connection/test-fixtures/fake-mac";
import { DEMO_REPLY } from "./core";
import { createDemoMac } from "./demo-mac";
import { HERO_APPROVAL, HERO_THREAD } from "./hero";

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 26, 12) });
});
afterEach(() => {
  vi.useRealTimers();
});

const clock = {
  now: () => Date.now(),
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const HERO_RUN = "demo-run-hero";

function showDemo() {
  const mac = new FakeMac();
  const manager = new ConnectionManager(effectsFor(mac));
  manager.start("wifi");
  manager.showDemo(createDemoMac(clock));
  const pushes: ClientPush[] = [];
  manager.connection.onPush((push) => pushes.push(push));
  const call = manager.connection.call.bind(manager.connection);
  const hero = () => call("threads.get", { id: HERO_THREAD });
  return { mac, manager, pushes, call, hero };
}

const frames = (pushes: ClientPush[]) => pushes.flatMap((push) => (push.type === "frame" ? [push.frame] : []));
const eventTypes = (pushes: ClientPush[]) => frames(pushes).flatMap((frame) => frame.events.map((event) => event.type));

/** Holds the hero's run, as Home's row does, and plays its turn up to the approval. */
async function untilApproval(demo: ReturnType<typeof showDemo>) {
  demo.manager.connection.setFrameInterest(new Set([HERO_RUN]));
  await advance(60_000);
  expect(await demo.hero()).toMatchObject({ activity: "waiting" });
}

describe("the demo Mac", () => {
  it("lists OpenOrc's own projects and threads, shaped as a Mac's", async () => {
    const { call } = showDemo();
    expect((await call("projects.list", {})).map((project) => project.name)).toEqual(["website", "openorc"]);
    const threads = await call("threads.list", {});
    expect(threads.map((thread) => thread.title)).toEqual([
      "Calmer hero",
      "Review the pairing handshake",
      "Page long transcripts",
      "Keep the agents on one line",
      "Release notes for 0.9",
      "Summarize the week",
    ]);
    for (const thread of threads) {
      expect(ThreadSummary.safeParse(thread).success).toBe(true);
      expect(await call("threads.messages", { id: thread.id })).toEqual([]);
      for (const run of await call("runs.listForThread", { threadId: thread.id })) expect(Run.safeParse(run).success).toBe(true);
      const page = await call("events.page", { runId: thread.liveRunId ?? (await call("runs.listForThread", { threadId: thread.id }))[0]!.id });
      for (const event of page.events) expect(AgentEvent.safeParse(event).success).toBe(true);
    }
  });

  it("starts the live thread's agent once its run is held: work, words, then an approval to wait on", async () => {
    const demo = showDemo();
    await advance(10_000);
    expect(eventTypes(demo.pushes)).toEqual([]);
    await untilApproval(demo);
    const types = eventTypes(demo.pushes);
    expect(types.slice(0, 3)).toEqual(["turn.started", "message.completed", "thinking.started"]);
    expect(types).toContain("file.changed");
    expect(types.filter((type) => type === "message.delta").length).toBeGreaterThan(10);
    expect(types.at(-1)).toBe("approval.requested");
    for (const frame of frames(demo.pushes)) expect(Frame.safeParse(frame).success).toBe(true);
    expect((await demo.call("inbox.list", {})).items).toMatchObject([{ kind: "thread", runId: HERO_RUN, reason: "approval" }]);
    expect((await demo.call("review.threadChanges", { threadId: HERO_THREAD, comparison: "head" })).totals).toEqual({ files: 2, insertions: 7, deletions: 3 });
    expect(await demo.call("preview.state", { threadId: HERO_THREAD })).toMatchObject({ open: true, address: "localhost:4321", frame: { seq: 1, width: 780, height: 920 } });
    expect(demo.pushes).toContainEqual({ type: "invalidate", keys: ["preview", `preview:${HERO_THREAD}`] });
  });

  it("goes on after Allow: the build's output, the last words, and a thread done and unread", async () => {
    const demo = showDemo();
    await untilApproval(demo);
    demo.pushes.length = 0;
    await demo.call("approvals.resolve", { runId: HERO_RUN, approvalId: HERO_APPROVAL, decision: "allow" });
    await advance(30_000);
    const types = eventTypes(demo.pushes);
    expect(types[0]).toBe("approval.resolved");
    expect(types.filter((type) => type === "tool.output.delta").length).toBe(10);
    expect(types.at(-1)).toBe("turn.completed");
    expect(await demo.hero()).toMatchObject({ activity: "idle", unread: true });
    await expect(demo.call("approvals.resolve", { runId: HERO_RUN, approvalId: HERO_APPROVAL, decision: "allow" })).rejects.toThrow("This approval was already answered.");
  });

  it("ends the turn in one line after Deny", async () => {
    const demo = showDemo();
    await untilApproval(demo);
    demo.pushes.length = 0;
    await demo.call("approvals.resolve", { runId: HERO_RUN, approvalId: HERO_APPROVAL, decision: "deny" });
    await advance(30_000);
    const words = frames(demo.pushes).flatMap((frame) => frame.events.flatMap((event) => (event.type === "message.completed" ? [event.text] : [])));
    expect(words).toEqual(["Skipped the build. The edits are in place, and Preview shows them."]);
    expect(eventTypes(demo.pushes)).not.toContain("tool.started");
  });

  it("commits and pushes the changes, as git would, and shows each file's diff", async () => {
    const demo = showDemo();
    await untilApproval(demo);
    const diff = await demo.call("review.threadFileDiff", { threadId: HERO_THREAD, comparison: "head", path: FolderPath.parse("src/styles/home.css") });
    expect(diff.patch).toContain("+  margin-top: 32px;");
    const { sha } = await demo.call("review.commitThread", { threadId: HERO_THREAD, message: "Give the hero room" });
    expect((await demo.call("review.threadChanges", { threadId: HERO_THREAD, comparison: "head" })).files).toEqual([]);
    expect((await demo.call("review.threadChanges", { threadId: HERO_THREAD, comparison: "base" })).totals.files).toBe(2);
    expect(await demo.call("git.threadLog", { threadId: HERO_THREAD })).toMatchObject([{ sha, subject: "Give the hero room" }]);
    expect(await demo.call("git.threadPushState", { threadId: HERO_THREAD })).toMatchObject({ branch: "site/calmer-hero", unpushedCount: 1, published: false });
    expect(await demo.call("review.pushThread", { threadId: HERO_THREAD })).toEqual({ remote: "origin", branch: "site/calmer-hero" });
    expect(await demo.call("git.threadPushState", { threadId: HERO_THREAD })).toMatchObject({ unpushedCount: 0, published: true });
    await expect(demo.call("review.commitThread", { threadId: HERO_THREAD, message: "Again" })).rejects.toThrow("Nothing to commit.");
    expect(await demo.call("system.gh", {})).toEqual({ installed: false });
  });

  it("answers a message with one honest line, queues behind a working turn, and stops one", async () => {
    const demo = showDemo();
    const said = async (runId: string) => (await demo.call("events.page", { runId })).events.flatMap((event) => (event.type === "message.completed" ? [`${event.role}: ${event.text}`] : [])).slice(-2);
    const run = await demo.call("runs.start", { threadId: "demo-week", agent: "claude", mode: "act", permissionMode: "trusted", prompt: "Plan next week" });
    await advance(10_000);
    expect(await said(run.id)).toEqual(["user: Plan next week", `assistant: ${DEMO_REPLY}`]);
    expect(await demo.call("threads.get", { id: "demo-week" })).toMatchObject({ liveRunId: run.id, activity: "idle", session: { status: "live" } });
    await untilApproval(demo);
    expect(await demo.call("threads.queue", { id: HERO_THREAD, text: "Then commit it" })).toMatchObject([{ text: "Then commit it" }]);
    await demo.call("runs.interrupt", { runId: HERO_RUN });
    await advance(10_000);
    expect(await said(HERO_RUN)).toEqual(["user: Then commit it", `assistant: ${DEMO_REPLY}`]);
    expect(await demo.hero()).toMatchObject({ activity: "idle", queued: [] });
  });

  it("starts a new thread that answers the same way, and serves an image attached to it back by its name", async () => {
    const demo = showDemo();
    const { path } = await demo.call("attachments.save", { name: "sketch.jpg", mime: "image/jpeg", dataBase64: btoa("\xff\xd8\xff") });
    const { thread, run } = await demo.call("threads.start", {
      projectId: "website",
      agent: "claude",
      model: "claude-opus-5-5",
      mode: "act",
      permissionMode: "trusted",
      prompt: "Match this sketch",
      attachments: [path],
    });
    await advance(10_000);
    expect(ThreadSummary.safeParse(await demo.call("threads.get", { id: thread.id })).success).toBe(true);
    expect((await demo.call("threads.list", { projectId: "website" }))[0]).toMatchObject({ id: thread.id, title: "Match this sketch", liveRunId: run!.id });
    const asked = (await demo.call("events.page", { runId: run!.id })).events.find((event) => event.type === "message.completed" && event.role === "user");
    expect(asked).toMatchObject({ text: "Match this sketch", attachments: [path] });
    const image = await demo.manager.connection.asset({ kind: "attachment", name: path.split("/").pop()! });
    expect([...image.bytes]).toEqual([0xff, 0xd8, 0xff]);
  });

  it("shows the hero's page in Preview as a JPEG frame, and takes input that changes nothing", async () => {
    const demo = showDemo();
    expect(await demo.manager.connection.session("preview.watch", { threadId: HERO_THREAD, width: 780, pace: "lan" })).toEqual({ open: false });
    await untilApproval(demo);
    const state = await demo.manager.connection.session("preview.watch", { threadId: HERO_THREAD, width: 780, pace: "lan" });
    expect(state).toMatchObject({ open: true, phase: "live" });
    const frame = await demo.manager.connection.asset({ kind: "preview", threadId: HERO_THREAD, seq: 1 });
    expect(frame.mime).toBe("image/jpeg");
    expect([...frame.bytes.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    await expect(demo.manager.connection.asset({ kind: "preview", threadId: HERO_THREAD, seq: 2 })).rejects.toThrow();
    expect(
      await demo.manager.connection.session("preview.input", { threadId: HERO_THREAD, pane: "4e1f0c9a2b7d", frame: { width: 780, height: 920 }, input: { kind: "tap", x: 10, y: 10, count: 1 } }),
    ).toEqual({
      focus: null,
    });
  });

  it("hands the phone copies, as the wire does: a page it read never grows under it", async () => {
    const demo = showDemo();
    const page = await demo.call("events.page", { runId: HERO_RUN });
    const read = page.events.length;
    await untilApproval(demo);
    expect(page.events.length).toBe(read);
    expect((await demo.call("events.page", { runId: HERO_RUN })).events.length).toBeGreaterThan(read);
  });

  it("refuses this phone's own methods, so push never registers with it", async () => {
    const demo = showDemo();
    await expect(demo.manager.connection.device("push.register", { registration: null })).rejects.toThrow("This is not available from a phone.");
  });

  it("keeps nothing from one demo to the next, and never reaches a network", async () => {
    const demo = showDemo();
    await untilApproval(demo);
    await demo.call("review.commitThread", { threadId: HERO_THREAD, message: "Give the hero room" });
    await demo.call("threads.update", { id: "demo-week", patch: { archived: true } });
    demo.manager.endDemo();
    demo.manager.showDemo(createDemoMac(clock));
    expect(await demo.call("git.threadLog", { threadId: HERO_THREAD })).toEqual([]);
    expect((await demo.call("threads.list", {})).map((thread) => thread.id)).toContain("demo-week");
    expect(await demo.call("threads.get", { id: "demo-week" })).toMatchObject({ archivedAt: null });
    expect(demo.mac.dials).toEqual([]);
    expect(demo.mac.internetChecks).toBe(0);
  });
});
