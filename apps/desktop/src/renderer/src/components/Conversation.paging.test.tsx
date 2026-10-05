import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentEvent, Project, Run, ThreadSummary } from "@openorc/protocol";
import { applyFrame, flushTranscripts, resetTranscripts } from "../lib/transcript";
import { core } from "../lib/rpc";
import { Conversation } from "./Conversation";
import { ThreadChangeCard } from "./ThreadChangeCard";
import { useConversationTranscript } from "../lib/conversation-transcript";

const queries = vi.hoisted(() => new Map<string, unknown>());
const restore = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../lib/rpc", () => ({
  core: new Proxy({ call: vi.fn() } as Record<string, unknown>, { get: (target, key: string) => (key in target ? target[key] : () => () => undefined) }),
}));
vi.mock("../lib/query", () => ({
  useRpc: (method: string) => ({ data: queries.get(method), isLoading: false, isPending: false, isError: false, error: null, refetch: () => undefined }),
  useRpcMutation: () => ({ mutate: () => undefined, mutateAsync: restore, isPending: false, error: null }),
  invalidateTags: () => undefined,
}));
vi.mock("./Composer", async (original) => ({ ...(await original<object>()), Composer: () => null }));
vi.mock("./AgentOrb", () => ({ AgentOrb: () => null }));

// The top of the transcript is always in reach here, so older turns load as far as there are any.
class Near {
  constructor(private readonly callback: (entries: { isIntersecting: boolean }[]) => void) {}
  observe() {
    this.callback([{ isIntersecting: true }]);
  }
  disconnect() {}
}
class Resize {
  observe() {}
  disconnect() {}
}
Object.assign(globalThis, { IntersectionObserver: Near, ResizeObserver: Resize });

/** What the core would answer events.page with, from each run's events. */
const ledger = new Map<string, AgentEvent[]>();
let id = 0;
const next = () => `e${++id}`;
function turn(runId: string, n: number, ts: number): AgentEvent[] {
  return [
    { type: "message.completed", runId, ts, messageId: `${runId}-ask-${n}`, role: "user", text: `${runId} question ${n}`, eventId: next() },
    { type: "message.completed", runId, ts: ts + 1, messageId: `${runId}-reply-${n}`, role: "assistant", text: `${runId} answer ${n}`, eventId: next() },
    { type: "turn.completed", runId, ts: ts + 2, turnId: `${runId}-turn-${n}`, status: "success", durationMs: 1, eventId: next() },
  ];
}
function session(runId: string, turns: number, ts: number, closed = true): AgentEvent[] {
  const events: AgentEvent[] = [{ type: "session.started", runId, ts, agent: "codex", externalSessionId: runId, model: "m", eventId: next() }];
  for (let n = 0; n < turns; n++) events.push(...turn(runId, n, ts + 10 + n * 10));
  if (closed) events.push({ type: "session.completed", runId, ts: ts + 10 + turns * 10, status: "success", durationMs: 1, eventId: next() });
  return events;
}
function page(runId: string, request: { fromTurn?: number; turns?: number }) {
  const events = ledger.get(runId) ?? [];
  const ends = events.flatMap((ev, i) => (ev.type === "turn.completed" ? [i] : []));
  const fromTurn = Math.min(ends.length, Math.max(0, request.fromTurn ?? (request.turns !== undefined ? ends.length - request.turns : 0)));
  return { events: structuredClone(events.slice(fromTurn > 0 ? ends[fromTurn - 1]! + 1 : 0)), fromTurn, live: false };
}

const thread = {
  id: "thread",
  projectId: "project",
  title: "t",
  agent: "codex",
  model: "m",
  mode: "act",
  permissionMode: "review",
  workspaceMode: "current",
  activity: "idle",
  queued: [],
} as unknown as ThreadSummary;
const project = { id: "project", name: "project", rootPath: "/tmp/project" } as Project;
const run = (runId: string, startedAt: number) =>
  ({ id: runId, threadId: "thread", taskId: null, agent: "codex", model: "m", mode: "act", permissionMode: "review", state: "success", startedAt }) as unknown as Run;
const client = new QueryClient();
const view = () => (
  <QueryClientProvider client={client}>
    <Conversation scope={{ kind: "thread", thread }} project={project} />
  </QueryClientProvider>
);
const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
  act(() => flushTranscripts());
};
const answers = (container: HTMLElement, runId: string) => (container.textContent?.match(new RegExp(`${runId} answer \\d`, "g")) ?? []).length;

beforeEach(() => {
  resetTranscripts();
  ledger.clear();
  queries.clear();
  restore.mockClear();
  vi.mocked(core.call).mockReset();
  vi.mocked(core.call).mockImplementation((async (method: string, params: { runId: string; fromTurn?: number; turns?: number }) => {
    if (method !== "events.page") return undefined;
    const { runId, ...request } = params;
    return page(runId, request);
  }) as never);
});
afterEach(cleanup);

it("keeps the earlier conversation in view while a new run starts", async () => {
  ledger.set("A", session("A", 3, 1000));
  queries.set("runs.listForThread", [run("A", 1000)]);
  const { container, rerender } = render(view());
  await settle();
  expect(answers(container, "A")).toBe(3);

  // The new run's prompt arrives before the runs list knows about it, and its page takes a moment.
  const prompt: AgentEvent[] = [{ type: "message.completed", runId: "C", ts: 50_000, messageId: "C-ask", role: "user", text: "next please", eventId: next() }];
  ledger.set("C", prompt);
  act(() => {
    applyFrame({ runId: "C", seq: 1, events: prompt });
    flushTranscripts();
  });
  queries.set("runs.listForThread", [run("A", 1000), run("C", 50_000)]);
  rerender(view());
  expect(answers(container, "A")).toBe(3);
  expect(container.textContent).toContain("next please");
  await settle();
  expect(answers(container, "A")).toBe(3);
});

it("reaches back past a live run seen from its start to the runs before it", async () => {
  ledger.set("A", session("A", 2, 1000));
  const live = session("C", 1, 50_000, false);
  ledger.set("C", live);
  act(() => {
    applyFrame({ runId: "C", seq: 1, events: live });
    flushTranscripts();
  });
  queries.set("runs.listForThread", [run("A", 1000), run("C", 50_000)]);
  const { container } = render(view());
  await settle();
  await settle();
  expect(answers(container, "C")).toBe(1);
  expect(answers(container, "A")).toBe(2);
});

it("opens on the newest turns and loads the rest of a long run as the top comes into reach", async () => {
  ledger.set("A", session("A", 11, 1000));
  queries.set("runs.listForThread", [run("A", 1000)]);
  const calls = vi.mocked(core.call).mock.calls;
  const { container } = render(view());
  await settle();
  await settle();
  expect(answers(container, "A")).toBe(11);
  expect(
    calls.filter(([method]) => method === "events.page").map(([, params]) => (params as { fromTurn?: number; turns?: number }).turns ?? `from ${(params as { fromTurn: number }).fromTurn}`),
  ).toEqual([4, "from 3", "from 0"]);
});

it("places each checkpoint after its completed turn and preserves cards while the next reply streams", async () => {
  ledger.set("A", session("A", 2, 1000, false));
  queries.set("threads.checkpoints", [
    { id: "first", runId: "A", turn: 1 },
    { id: "second", runId: "A", turn: 2 },
  ]);
  const runs = [run("A", 1000)];
  const { result } = renderHook(() => useConversationTranscript({ runs, threadId: "thread", basePath: "/tmp/project" }));
  await settle();
  const cards = result.current.turnCards;
  expect([...cards]).toEqual([
    ["turn-A-turn-0", { checkpointId: "first", previousCheckpointId: null, paths: [] }],
    ["turn-A-turn-1", { checkpointId: "second", previousCheckpointId: "first", paths: [] }],
  ]);
  act(() => {
    applyFrame({ runId: "A", seq: 1, events: [{ type: "message.delta", runId: "A", ts: 2000, messageId: "next-reply", role: "assistant", text: "Working", eventId: next() }] });
    flushTranscripts();
  });
  expect(result.current.merged?.blocks.at(-1)).toMatchObject({ text: "Working", streaming: true });
  expect(result.current.turnCards).toBe(cards);
});

it("offers Undo on the first turn using its starting files without a separate baseline card", async () => {
  ledger.set("A", session("A", 1, 1000));
  queries.set("threads.checkpoints", [
    { id: "starting-files", runId: null, turn: 0 },
    { id: "first", runId: "A", turn: 1 },
  ]);
  queries.set("threads.turnChanges", { files: [{ path: "README.md", added: 1, removed: 1 }] });
  const runs = [run("A", 1000)];
  const { result } = renderHook(() => useConversationTranscript({ runs, threadId: "thread", basePath: "/tmp/project" }));
  await settle();
  expect(result.current.turnCards.size).toBe(1);
  const card = result.current.turnCards.get("turn-A-turn-0")!;
  expect(card.previousCheckpointId).toBe("starting-files");
  const { rerender } = render(<ThreadChangeCard threadId="thread" {...card} working={true} />);
  expect(screen.getByRole("button", { name: "Undo this turn's changes" }).hasAttribute("disabled")).toBe(true);
  rerender(<ThreadChangeCard threadId="thread" {...card} working={false} />);
  const undo = screen.getByRole("button", { name: "Undo this turn's changes" });
  expect(undo.hasAttribute("disabled")).toBe(false);
  fireEvent.click(undo);
  expect(restore).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Confirm undo" })));
  expect(restore).toHaveBeenCalledExactlyOnceWith({ id: "thread", checkpointId: "starting-files" });
});

it("keeps legacy Undo disabled when the turn has no starting checkpoint", () => {
  queries.set("threads.turnChanges", { files: [{ path: "README.md", added: 1, removed: 1 }] });
  render(<ThreadChangeCard threadId="thread" checkpointId="legacy" previousCheckpointId={null} paths={[]} working={false} />);
  const undo = screen.getByRole("button", { name: "Undo this turn's changes" });
  expect(undo.hasAttribute("disabled")).toBe(true);
  fireEvent.click(undo);
  expect(restore).not.toHaveBeenCalled();
});
