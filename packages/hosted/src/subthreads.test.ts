import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hostedRunId } from "@openorc/protocol";
import { createHosted } from "./index.js";
import { subthreadFixture } from "./test-fixtures/subthreads.js";
import { nativeRowsFromEvents } from "./translate-subthreads.js";

let f: Awaited<ReturnType<typeof subthreadFixture>>;
beforeEach(async () => {
  f = await subthreadFixture();
  await vi.waitFor(() => expect(f.hosted.threads.holds({ thread: f.child })).toBe(true));
});
afterEach(async () => {
  f.hosted.close();
  await f.server.close();
});

it("does not copy a parent's personal view state onto a newly observed child", () => {
  const parent = { ...f.threads.row(f.root), pinnedAt: "2026-01-01T00:00:00.000Z", archivedAt: "2026-01-01T00:00:00.000Z", snoozedUntil: "2026-01-01T00:00:00.000Z" };
  const [child] = nativeRowsFromEvents(parent, [{ seq: 1, event: { type: "subagent.started", threadId: "new-child", title: "Inspect tests" } }], new Set());
  expect(child).toMatchObject({ pinnedAt: null, archivedAt: null, snoozedUntil: null, seenSeq: 0, lastAgentSeq: 0 });
});

it("registers nested native rows as read-only cloud children with their actual status", async () => {
  const rows = f.hosted.threads.listed("threads.list", { includeChildren: true })?.rows;
  expect(rows?.find((row) => row.id === f.child)).toMatchObject({ parentRelation: "subagent", parentThreadId: f.root, owner: { brain: "hosted" }, subagent: { status: "running", stoppable: true } });
  expect(rows?.find((row) => row.id === f.nested)).toMatchObject({ parentRelation: "subagent", parentThreadId: f.child, subagent: { status: "completed", stoppable: false } });
});

it("keeps a child read failure separate from an empty transcript", async () => {
  f.state.metadataStatus = 503;
  await expect(f.hosted.threads.call("runs.listForThread", { threadId: f.child })).rejects.toThrow("Could not read subthreads.");
});

it("reads the child's persisted page without mixing in parent text or usage", async () => {
  f.server.append(f.root, [{ type: "message.completed", runId: "root-run", ts: 1, messageId: "parent", role: "assistant", text: "Parent output" }]);
  f.server.append(f.child, [
    { type: "message.completed", runId: "child-run", ts: 2, messageId: "child", role: "assistant", text: "Child output" },
    { type: "usage.updated", runId: "child-run", ts: 3, usage: { inputTokens: 900, outputTokens: 90 } },
  ]);
  const page = await f.hosted.threads.call("events.page", { runId: hostedRunId(f.child), turns: 1 });
  expect(page.events).toEqual([
    expect.objectContaining({ type: "message.completed", runId: hostedRunId(f.child), text: "Child output" }),
    expect.objectContaining({ type: "usage.updated", runId: hostedRunId(f.child), usage: { inputTokens: 900, outputTokens: 90 } }),
  ]);
  const parent = await f.hosted.threads.call("events.page", { runId: hostedRunId(f.root), turns: 1 });
  expect(parent.events).toEqual([expect.objectContaining({ text: "Parent output" })]);
});

it("does not reread unchanged completed native families on every catalog refresh", async () => {
  f.metadata[0]!.status = "completed";
  f.server.append(f.child, [{ type: "message.completed", runId: "child", ts: 3, messageId: "finished", role: "assistant", text: "Finished" }], { quiet: true });
  await f.threads.refresh();
  const before = f.state.metadataReads;
  await f.threads.refresh();
  await f.threads.refresh();
  expect(f.state.metadataReads).toBe(before);
});

it("refreshes a running child's capability even without another transcript event", async () => {
  f.metadata[0]!.stoppable = false;
  f.metadata[0]!.hostRunId = "host-two";
  await f.threads.refresh();
  expect(await f.threads.call("threads.get", { id: f.child })).toMatchObject({ subagent: { stoppable: false, hostRunId: "host-two" } });
});

it("fences selected Stop to the displayed host handle and retains its id after a lost response", async () => {
  f.state.lost = true;
  await expect(f.hosted.threads.call("subagents.stop", { threadId: f.child, expectedRunId: "host-one" })).rejects.toThrow("OpenOrc Cloud can't be reached.");
  f.state.lost = false;
  await f.hosted.threads.call("subagents.stop", { threadId: f.child, expectedRunId: "host-one" });
  expect(f.stops).toHaveLength(2);
  expect(f.stops[0]).toEqual(f.stops[1]);
  expect(f.stops[0]).toMatchObject({ path: `/hosted/threads/${f.child}/subagent/stop`, body: { id: expect.any(String), expectedRunId: "host-one" }, space: expect.any(String) });
});

it("retains a lost selected Stop request across a device restart", async () => {
  f.state.lost = true;
  await expect(f.threads.call("subagents.stop", { threadId: f.child, expectedRunId: "host-one" })).rejects.toThrow();
  f.hosted.close();
  f.state.lost = false;
  const reopened = createHosted(f.deps);
  try {
    await reopened.start();
    await vi.waitFor(() => expect(reopened.threads.holds({ thread: f.child })).toBe(true));
    await reopened.threads.call("subagents.stop", { threadId: f.child, expectedRunId: "host-one" });
    expect(f.stops[1]).toEqual(f.stops[0]);
  } finally {
    reopened.close();
  }
});

it("refuses unsupported and stale handles without interrupting the parent", async () => {
  await expect(f.hosted.threads.call("subagents.stop", { threadId: f.child, expectedRunId: "old-host" })).rejects.toThrow("can't be stopped separately");
  f.metadata[0]!.stoppable = false;
  await expect(f.hosted.threads.call("subagents.stop", { threadId: f.child, expectedRunId: "host-one" })).rejects.toThrow("can't be stopped separately");
  await expect(f.hosted.threads.call("runs.interrupt", { runId: hostedRunId(f.child) })).rejects.toThrow("read-only");
  expect(f.stops).toEqual([]);
  expect(f.server.requests.some((request) => request.path.endsWith("/stop"))).toBe(false);
});

it("fills a missing ancestor and keeps nested rows across a device restart", async () => {
  f.state.omitRoot = true;
  await f.threads.refresh();
  expect(f.threads.holds({ thread: f.root })).toBe(true);
  f.hosted.close();
  const reopened = createHosted(f.deps);
  try {
    await reopened.start();
    await vi.waitFor(() => expect(reopened.threads.holds({ thread: f.nested })).toBe(true));
    expect(await reopened.threads.call("threads.get", { id: f.nested })).toMatchObject({ parentRelation: "subagent", parentThreadId: f.child, subagent: { status: "completed" } });
  } finally {
    reopened.close();
  }
});

it("registers child ownership before handing a live card to the renderer", async () => {
  await f.hosted.threads.call("events.page", { runId: hostedRunId(f.root), turns: 1 });
  const late = f.server.addThread("reader@example.com", { title: "Inspect tests", projectId: null });
  f.metadata.push({ ...f.metadata[1]!, id: late, parentId: f.root });
  f.state.hidden.add(late);
  const ownership: boolean[] = [];
  f.state.frame = (id) => ownership.push(f.threads.holds({ thread: id }));
  f.server.append(f.root, [{ type: "subagent.started", runId: "host-one", ts: 2, subagentId: "native-late", threadId: late, title: "Inspect tests" }]);
  await vi.waitFor(() => expect(ownership).toEqual([true]));
  expect(await f.hosted.threads.call("threads.get", { id: late })).toMatchObject({ parentRelation: "subagent", owner: { brain: "hosted" } });
});

it("drops the whole native family when access is refused during refresh", async () => {
  f.state.metadataStatus = 403;
  f.server.append(f.child, [{ type: "message.completed", runId: "child", ts: 3, messageId: "changed", role: "assistant", text: "More work" }], { quiet: true });
  await f.threads.refresh();
  expect([f.root, f.child, f.nested].map((thread) => f.threads.holds({ thread }))).toEqual([false, false, false]);
});

it("discards a child read when the signed-in account changes before it returns", async () => {
  f.state.beforeReply = () => f.hosted.account.signOut();
  await expect(f.hosted.threads.call("runs.listForThread", { threadId: f.child })).rejects.toThrow("no longer have access");
  expect(f.threads.holds({ thread: f.child })).toBe(false);
});

it("keeps an old server's missing route distinct from a clean child history", async () => {
  f.state.metadataStatus = 404;
  await expect(f.hosted.threads.call("runs.listForThread", { threadId: f.child })).rejects.toThrow("Subthreads aren't available");
});

it("does not report a refused Stop replay as completion", async () => {
  f.state.stopStatus = 409;
  await expect(f.hosted.threads.call("subagents.stop", { threadId: f.child, expectedRunId: "host-one" })).rejects.toThrow("can't be stopped separately");
  expect(await f.hosted.threads.call("threads.get", { id: f.child })).toMatchObject({ subagent: { status: "running" } });
});
