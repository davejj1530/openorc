// @vitest-environment jsdom
import type { Block } from "@openorc/client";
import type { AgentEvent, InboxItem, InboxList, Run, Task } from "@openorc/protocol";
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queueAnswer } from "../notifications/answers";
import type { FakeMac } from "../test-fixtures/fake-mac";

vi.mock("expo-router", () => ({ router: { push: () => undefined } }));
const mac = vi.hoisted(() => ({
  phone: null as FakeMac | null,
  inbox: { items: [] } as InboxList,
  pages: new Map<string, AgentEvent[]>(),
  firstPaged: new Map<string, number>(),
  resolved: [] as unknown[],
}));
vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac(async (method, params) => {
    if (method === "inbox.list") return mac.inbox;
    if (method === "threads.messages") return [];
    if (method === "events.page") {
      // A run longer than the page asked for starts its newest turns where `firstPaged` says.
      const { runId, turns, fromTurn } = params as { runId: string; turns?: number; fromTurn?: number };
      return { events: mac.pages.get(runId) ?? [], fromTurn: turns === undefined ? (fromTurn ?? 0) : (mac.firstPaged.get(runId) ?? 0), live: true };
    }
    if (method !== "approvals.resolve") throw new Error(`no ${method}`);
    mac.resolved.push(params);
    return null;
  });
  return mac.phone.module;
});

const { client } = await import("../client");
const { ApprovalCard } = await import("./cards");
const { useWaitingApprovals, waitingRuns } = await import("./waiting-approvals");

const task = (id: string, threadId: string | null, title = `Task ${id}`): Task => ({
  id,
  projectId: "p",
  title,
  spec: null,
  status: "in_progress",
  priority: "none",
  labels: [],
  workspaceMode: "current",
  baseRef: null,
  baseSha: null,
  branch: null,
  worktreePath: null,
  parentTaskId: null,
  threadId,
  executionThreadId: null,
  origin: "agent",
  reviewedSnapshotId: null,
  costUsd: 0,
  createdAt: 1,
  updatedAt: 1,
  completedAt: null,
});
const waitingOn = (runId: string, on: Task): InboxItem => ({ kind: "task", task: on, runId, reason: "approval", detail: "Waiting for permission" });
const waitingIn = (runId: string, threadId: string): InboxItem => ({
  kind: "thread",
  thread: { id: threadId } as Extract<InboxItem, { kind: "thread" }>["thread"],
  runId,
  reason: "approval",
  detail: "Bash",
});
const said = (runId: string, n: number): AgentEvent => ({ type: "message.completed", eventId: `${runId}-${n}`, runId, ts: n, messageId: `${runId}-${n}`, role: "assistant", text: `Reply ${n}` });
const asked = (runId: string, approvalId: string): AgentEvent => ({
  type: "approval.requested",
  eventId: `${runId}-${approvalId}`,
  runId,
  ts: 1,
  approvalId,
  kind: "command",
  input: { command: "pnpm test" },
});

beforeEach(() => {
  mac.inbox = { items: [] };
  mac.pages.clear();
  mac.firstPaged.clear();
  mac.resolved = [];
  client.runs.reset();
  client.queryClient.clear();
});
afterEach(cleanup);

describe("the runs that wait on the person outside the loaded conversation", () => {
  it("are the inbox's waiting runs of the thread and of its tasks, apart from the runs the conversation shows, once each", () => {
    const fix = task("fix", "t1", "Fix the flaky test");
    const inbox: InboxList = {
      items: [
        waitingOn("fix-run", fix),
        waitingOn("fix-run", fix),
        waitingOn("elsewhere-run", task("elsewhere", "t2")),
        waitingIn("lead-run", "t1"),
        waitingIn("other-thread-run", "t2"),
        waitingIn("newest-run", "t1"),
        { kind: "task", task: task("review", "t1"), runId: null, reason: "review", detail: "Finished run waiting for your review" },
      ],
    };
    expect(waitingRuns(inbox, "t1", ["newest-run"])).toEqual([
      { runId: "fix-run", task: "Fix the flaky test" },
      { runId: "lead-run", task: null },
    ]);
    expect(waitingRuns(inbox, "t1", ["lead-run", "newest-run"])).toEqual([{ runId: "fix-run", task: "Fix the flaky test" }]);
    expect(waitingRuns(undefined, "t1", [])).toEqual([]);
  });
});

/** A team thread: the lead's warm run waits on an approval while a member's newer run holds the conversation. */
function teamThread() {
  mac.inbox = { items: [waitingIn("lead", "t1")] };
  mac.pages.set("lead", [asked("lead", "lead-ap")]);
  mac.pages.set(
    "member",
    [1, 2, 3, 4, 5, 6].map((n) => said("member", n)),
  );
  mac.firstPaged.set("member", 2);
  return [{ id: "lead" }, { id: "member" }] as Run[];
}

/** The thread screen's conversation and what waits outside it, composed as its transcript pane composes them. */
function useThread(runs: Run[]) {
  const conversation = client.useConversationTranscript({ runs, threadId: "t1" });
  return { ...conversation, waiting: useWaitingApprovals("t1", conversation.shown) };
}

const openIn = (blocks: readonly Block[] | undefined) => (blocks ?? []).flatMap((block) => (block.kind === "approval" && !block.decision ? [block.approvalId] : []));

describe("an approval of an older run of the thread", () => {
  it("waits after the conversation, which has loaded only the newest run, and moves into it once that run loads", async () => {
    const runs = teamThread();
    const { result } = renderHook(() => useThread(runs), { wrapper: mac.phone!.wrapper });
    await waitFor(() => expect(result.current.waiting).toEqual([{ runId: "lead", task: null, blocks: [expect.objectContaining({ kind: "approval", approvalId: "lead-ap" })] }]));
    expect(result.current.shown).toEqual(["member"]);
    expect(openIn(result.current.merged?.blocks)).toEqual([]);

    // The reader scrolls up through the member's earlier turns, then into the lead's run.
    act(() => result.current.loadOlder());
    await waitFor(() => expect(client.runs.get("member")?.fromTurn).toBe(0));
    expect(result.current.shown).toEqual(["member"]);
    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.shown).toEqual(["lead", "member"]));
    expect(result.current.waiting).toEqual([]);
    expect(openIn(result.current.merged?.blocks)).toEqual(["lead-ap"]);
  });

  it("sends Allow chosen on its alert through the card the thread shows for it", async () => {
    const runs = teamThread();
    queueAnswer({ macId: "mac-1", runId: "lead", approvalId: "lead-ap" }, "allow", Date.now());
    function Thread() {
      return useThread(runs).waiting.flatMap(({ runId, blocks }) => blocks.map((block) => <ApprovalCard key={block.id} block={block} runId={runId} />));
    }
    render(<Thread />, { wrapper: mac.phone!.wrapper });
    await waitFor(() => expect(mac.resolved).toEqual([{ runId: "lead", approvalId: "lead-ap", decision: "allow" }]));
  });
});

describe("a task run's approval on its thread", () => {
  it("is read from the run, and leaves once it is answered", async () => {
    mac.inbox = { items: [waitingOn("fix-run", task("fix", "t1", "Fix the flaky test"))] };
    mac.pages.set("fix-run", [asked("fix-run", "0")]);
    const { result } = renderHook(() => useWaitingApprovals("t1", ["thread-run"]), { wrapper: mac.phone!.wrapper });
    await waitFor(() => expect(result.current).toEqual([{ runId: "fix-run", task: "Fix the flaky test", blocks: [expect.objectContaining({ kind: "approval", approvalId: "0" })] }]));
    const shown = result.current;
    act(() => {
      client.runs.applyFrame({ runId: "fix-run", seq: 1, events: [{ type: "message.delta", eventId: "delta", runId: "fix-run", ts: 2, messageId: "m", role: "assistant", text: "Waiting" }] });
      client.runs.flush();
    });
    expect(result.current).toBe(shown);

    act(() => {
      client.runs.applyFrame({ runId: "fix-run", seq: 2, events: [{ type: "approval.resolved", eventId: "resolved", runId: "fix-run", ts: 3, approvalId: "0", decision: "allow" }] });
      client.runs.flush();
    });
    await waitFor(() => expect(result.current).toEqual([]));
  });

  it("sends Allow chosen on its alert, which opened the thread, through the card the thread shows for it", async () => {
    mac.inbox = { items: [waitingOn("fix-run", task("fix", "t1"))] };
    mac.pages.set("fix-run", [asked("fix-run", "0")]);
    queueAnswer({ macId: "mac-1", runId: "fix-run", approvalId: "0" }, "allow", Date.now());
    function Thread() {
      return useWaitingApprovals("t1", ["thread-run"]).flatMap(({ runId, blocks }) => blocks.map((block) => <ApprovalCard key={block.id} block={block} runId={runId} />));
    }
    render(<Thread />, { wrapper: mac.phone!.wrapper });
    await waitFor(() => expect(mac.resolved).toEqual([{ runId: "fix-run", approvalId: "0", decision: "allow" }]));
  });
});
