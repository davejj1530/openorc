import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentEvent, Project, Run, ThreadCheckpoint, ThreadSummary } from "@openorc/protocol";
import { queryClient, runs as runStore, useConversationTranscript } from "../lib/client";
import { useTurnFooters } from "../lib/turn-footers";
import { core } from "../lib/rpc";
import { Conversation } from "./Conversation";

const answers = vi.hoisted(() => new Map<string, (params: Record<string, unknown>) => unknown>());
const restore = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../lib/rpc", () => ({
  core: new Proxy({ call: vi.fn() } as Record<string, unknown>, { get: (target, key: string) => (key in target ? target[key] : () => () => undefined) }),
}));
vi.mock("../lib/client", async (original) => ({
  ...(await original<object>()),
  useRpc: (method: string, params: Record<string, unknown>) => ({ data: answers.get(method)?.(params), isLoading: false, isPending: false, isError: false, error: null, refetch: () => undefined }),
  useRpcMutation: () => ({ mutate: () => undefined, mutateAsync: restore, isPending: false, error: null }),
  invalidateTags: () => undefined,
}));
vi.mock("./Composer", async (original) => ({ ...(await original<object>()), Composer: () => null }));
vi.mock("./AgentOrb", () => ({ AgentOrb: () => null }));

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

const ledger = new Map<string, AgentEvent[]>();
let id = 0;
const next = () => `e${++id}`;
const ask = (runId: string, n: number, ts: number): AgentEvent => ({
  type: "message.completed",
  runId,
  ts,
  messageId: `${runId}-ask-${n}`,
  role: "user",
  text: `${runId} question ${n}`,
  eventId: next(),
});
const reply = (runId: string, n: number, ts: number): AgentEvent[] => [
  { type: "message.completed", runId, ts, messageId: `${runId}-reply-${n}`, role: "assistant", text: `${runId} answer ${n}`, eventId: next() },
  { type: "turn.completed", runId, ts: ts + 1, turnId: `${runId}-turn-${n}`, status: "success", durationMs: 1, eventId: next() },
];
const started = (runId: string, ts: number): AgentEvent => ({ type: "session.started", runId, ts, agent: "codex", externalSessionId: runId, model: "m", eventId: next() });

const checkpoint = (id: string, createdAt: number, fields: Partial<ThreadCheckpoint> = {}): ThreadCheckpoint => ({
  id,
  threadId: "thread",
  runId: null,
  turn: 0,
  treeSha: id,
  diffStat: { files: 0, insertions: 0, deletions: 0, untracked: 0 },
  note: null,
  root: "/tmp/project",
  outside: null,
  createdAt,
  ...fields,
});
const changed = (...paths: string[]) => ({ files: paths.map((path) => ({ path, added: 1, removed: 0 })) });

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

function serve(runs: Run[], history: ThreadCheckpoint[], diffs: Record<string, ReturnType<typeof changed>>): Run[] {
  answers.set("runs.listForThread", () => runs);
  answers.set("threads.checkpoints", () => history);
  answers.set("threads.turnChanges", (params) => diffs[String(params["checkpointId"])]);
  return runs;
}

/** The window's own query cache, which the shared conversation hooks read through. */
const cached = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;

/** A conversation's turn footers, composed the way Conversation composes them. */
function useConversationFooters(runs: Run[]) {
  const { merged, transcripts } = useConversationTranscript({ runs, threadId: "thread" });
  const footers = useTurnFooters({ threadId: "thread", transcripts, blocks: merged?.blocks, basePath: "/tmp/project" });
  return { merged, footers };
}

async function settle() {
  for (let i = 0; i < 6; i++) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
  act(() => runStore.flush());
}

async function show() {
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <Conversation scope={{ kind: "thread", thread }} project={project} />
    </QueryClientProvider>,
  );
  await settle();
  return view.container;
}

/** Where each text first appears in the transcript, so a test can check what reads before what. */
const order = (container: HTMLElement, ...texts: string[]) => texts.map((text) => container.textContent!.indexOf(text));

/** A live process: the files were captured as the second turn began, before its prompt was recorded. */
const liveTurns = () => {
  ledger.set("A", [started("A", 1000), ask("A", 0, 1010), ...reply("A", 0, 1011), ask("A", 1, 1030), ...reply("A", 1, 1031)]);
  const history = [
    checkpoint("starting", 1005),
    checkpoint("A1", 1013, { runId: "A", turn: 1 }),
    checkpoint("mine", 1020, { turn: 1, outside: "user", note: "Your changes" }),
    checkpoint("A2", 1033, { runId: "A", turn: 2 }),
  ];
  return serve([run("A", 1000)], history, { A1: changed("agent.ts"), mine: changed("src/one.ts", "src/two.ts"), A2: changed("agent.ts") });
};

beforeEach(() => {
  runStore.reset();
  ledger.clear();
  answers.clear();
  restore.mockClear();
  vi.mocked(core.call).mockReset();
  vi.mocked(core.call).mockImplementation((async (method: string, params: { runId: string }) => {
    if (method === "threads.messages") return [];
    return method === "events.page" ? { events: structuredClone(ledger.get(params.runId) ?? []), fromTurn: 0, live: false } : undefined;
  }) as never);
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});

it("says the reader changed the files, between the last turn and the next prompt, with the files folded", async () => {
  liveTurns();
  const container = await show();
  const [answer, line, nextAsk] = order(container, "A answer 0", "You changed 2 files", "A question 1");
  expect(answer).toBeGreaterThanOrEqual(0);
  expect(line).toBeGreaterThan(answer!);
  expect(nextAsk).toBeGreaterThan(line!);
  expect(screen.queryByText(/one\.ts$/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show 2 files" }));
  expect(screen.getByText(/one\.ts$/)).toBeTruthy();
  expect(screen.getByText(/two\.ts$/)).toBeTruthy();
});

it("stays neutral when an agent may have changed the files, before the prompt a new process recorded first", async () => {
  ledger.set("A", [started("A", 1000), ask("A", 0, 1010), ...reply("A", 0, 1011), { type: "session.completed", runId: "A", ts: 1020, status: "success", durationMs: 1, eventId: next() }]);
  ledger.set("B", [ask("B", 0, 2000), started("B", 2005), ...reply("B", 0, 2010)]);
  const history = [
    checkpoint("starting", 1005),
    checkpoint("A1", 1013, { runId: "A", turn: 1 }),
    checkpoint("between", 2001, { turn: 1, outside: "unknown", note: "Changes between turns" }),
    checkpoint("B1", 2012, { runId: "B", turn: 1 }),
  ];
  serve([run("A", 1000), run("B", 2000)], history, { A1: changed("agent.ts"), between: changed("src/one.ts", "src/two.ts"), B1: changed("agent.ts") });
  const container = await show();
  const [answer, line, nextAsk] = order(container, "A answer 0", "2 files changed between turns", "B question 0");
  expect(answer).toBeGreaterThanOrEqual(0);
  expect(line).toBeGreaterThan(answer!);
  expect(nextAsk).toBeGreaterThan(line!);
  expect(container.textContent).not.toContain("You changed");
});

it("undoes the reader's changes back to where the last turn left the files, after a confirming click", async () => {
  liveTurns();
  await show();
  fireEvent.click(screen.getByRole("button", { name: "Undo your changes" }));
  expect(restore).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Confirm undo" })));
  expect(restore).toHaveBeenCalledExactlyOnceWith({ id: "thread", checkpointId: "A1" });
});

it("keeps the footers while the next reply streams, so finished turns keep their identity", async () => {
  const runs = liveTurns();
  const { result } = renderHook(() => useConversationFooters(runs), { wrapper: cached });
  await settle();
  const footers = result.current.footers;
  expect([...footers.outside]).toEqual([["turn-A-turn-0", [{ checkpointId: "mine", previousCheckpointId: "A1", by: "user" }]]]);
  expect(footers.cards.get("turn-A-turn-1")?.previousCheckpointId).toBe("mine");
  act(() => {
    runStore.applyFrame({ runId: "A", seq: 1, events: [{ type: "message.delta", runId: "A", ts: 2000, messageId: "next-reply", role: "assistant", text: "Working", eventId: next() }] });
    runStore.flush();
  });
  expect(result.current.merged?.blocks.at(-1)).toMatchObject({ text: "Working", streaming: true });
  expect(result.current.footers).toBe(footers);
});
