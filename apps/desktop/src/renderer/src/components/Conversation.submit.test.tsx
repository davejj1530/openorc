import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentEvent, AgentKind, PermissionPreset, Project, Run, RunMode, ThreadSummary } from "@openorc/protocol";
import { runs as runStore } from "../lib/client";
import { core } from "../lib/rpc";
import type { ComposerProps } from "./Composer";
import { Conversation } from "./Conversation";

const queries = vi.hoisted(() => new Map<string, unknown>());
const composer = vi.hoisted(() => ({ props: null as ComposerProps | null }));
vi.mock("../lib/rpc", () => ({
  core: new Proxy({ call: vi.fn() } as Record<string, unknown>, { get: (target, key: string) => (key in target ? target[key] : () => () => undefined) }),
}));
vi.mock("../lib/client", async (original) => ({
  ...(await original<object>()),
  useRpc: (method: string) => ({ data: queries.get(method), isLoading: false, isPending: false, isError: false, error: null, refetch: () => undefined }),
}));
vi.mock("./Composer", async (original) => ({
  ...(await original<object>()),
  Composer: (props: ComposerProps) => {
    composer.props = props;
    return null;
  },
}));
vi.mock("./AgentOrb", () => ({ AgentOrb: () => null }));
Object.assign(globalThis, {
  IntersectionObserver: class {
    observe() {}
    disconnect() {}
  },
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
});

type RunSpec = { id: string; agent: AgentKind; live: boolean; mode?: RunMode; permissionMode?: PermissionPreset };
const live = new Map<string, boolean>();
const project = { id: "project", name: "project", rootPath: "/tmp/project" } as Project;
const run = ({ id, agent, mode = "act", permissionMode = "trusted" }: RunSpec, index: number) =>
  ({ id, threadId: "thread", taskId: null, agent, model: "m", mode, permissionMode, state: "running", startedAt: 1000 + index }) as unknown as Run;
const thread = (overrides: Partial<ThreadSummary>) =>
  ({
    id: "thread",
    projectId: "project",
    title: "t",
    agent: "codex",
    model: "gpt-5",
    effort: null,
    fastMode: false,
    mode: "act",
    permissionMode: "trusted",
    workspaceMode: "current",
    activity: "idle",
    queued: [],
    ...overrides,
  }) as unknown as ThreadSummary;

/** Opens the conversation over the given runs and submits through the composer the way a person would. */
async function submit(options: { thread?: Partial<ThreadSummary>; runs?: RunSpec[]; text?: string; attachments?: string[]; now?: boolean }) {
  const runs = options.runs ?? [];
  for (const spec of runs) live.set(spec.id, spec.live);
  queries.set("runs.listForThread", runs.map(run));
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Conversation scope={{ kind: "thread", thread: thread(options.thread ?? {}) }} project={project} />
    </QueryClientProvider>,
  );
  for (let i = 0; i < 6; i++) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
  act(() => runStore.flush());
  try {
    await act(async () => composer.props!.onSubmit(options.text ?? "hello", options.attachments ?? [], options.now ?? false));
  } catch (error) {
    return { error: (error as Error).message };
  }
  // What reached the core, whichever hook made the call.
  return vi.mocked(core.call).mock.calls.filter(([method]) => sends.has(method));
}
const sends = new Set(["runs.start", "runs.send", "threads.queue"]);

beforeEach(() => {
  runStore.reset();
  queries.clear();
  live.clear();
  composer.props = null;
  vi.mocked(core.call).mockReset();
  vi.mocked(core.call).mockImplementation((async (method: string, params: { runId: string }) => {
    if (method !== "events.page") return undefined;
    const events: AgentEvent[] = [{ type: "session.started", runId: params.runId, ts: 1, agent: "codex", externalSessionId: params.runId, model: "m", eventId: `${params.runId}-1` }];
    if (!live.get(params.runId)) events.push({ type: "session.completed", runId: params.runId, ts: 2, status: "success", durationMs: 1, eventId: `${params.runId}-2` });
    return { events, fromTurn: 0, live: Boolean(live.get(params.runId)) };
  }) as never);
});
afterEach(cleanup);

const start = (resume: boolean, extra: object = {}) => [
  ["runs.start", { threadId: "thread", agent: "codex", model: "gpt-5", fastMode: false, attachments: [], mode: "act", permissionMode: "trusted", prompt: "hello", resume, ...extra }],
];

it.each([
  { name: "starts a process that resumes the agent's earlier session", runs: [{ id: "A", agent: "codex", live: false }], expected: start(true) },
  { name: "starts the first process fresh", expected: start(false) },
  {
    name: "starts fresh for an agent that never ran here",
    thread: { agent: "claude", model: "opus" },
    runs: [{ id: "A", agent: "codex", live: true }],
    expected: start(false, { agent: "claude", model: "opus" }),
  },
  { name: "continues on the warm process with the next turn", runs: [{ id: "A", agent: "codex", live: true }], expected: [["runs.send", { runId: "A", text: "hello", attachments: [] }]] },
  { name: "starts again when the mode changed since the process started", runs: [{ id: "A", agent: "codex", live: true, mode: "plan" }], expected: start(true) },
  { name: "starts again when permissions changed since the process started", runs: [{ id: "A", agent: "codex", live: true, permissionMode: "review" }], expected: start(true) },
  {
    name: "steers the running turn when asked for now",
    thread: { activity: "running" },
    runs: [{ id: "A", agent: "codex", live: true }],
    now: true,
    expected: [["runs.send", { runId: "A", text: "hello", attachments: [] }]],
  },
  {
    name: "queues behind a running turn by default",
    thread: { activity: "running" },
    runs: [{ id: "A", agent: "codex", live: true }],
    expected: [["threads.queue", { id: "thread", text: "hello", attachments: [], requestKey: expect.any(String) }]],
  },
  {
    name: "queues when the agent reads messages only between turns",
    thread: { activity: "running", agent: "opencode", model: "o" },
    runs: [{ id: "A", agent: "opencode", live: true }],
    now: true,
    expected: [["threads.queue", { id: "thread", text: "hello", attachments: [], requestKey: expect.any(String) }]],
  },
  {
    name: "queues when the running process has other settings",
    thread: { activity: "running" },
    runs: [{ id: "A", agent: "codex", live: true, mode: "plan" }],
    now: true,
    expected: [["threads.queue", { id: "thread", text: "hello", attachments: [], requestKey: expect.any(String) }]],
  },
  {
    name: "queues while the thread works without a live process",
    thread: { activity: "running" },
    runs: [{ id: "A", agent: "codex", live: false }],
    now: true,
    expected: [["threads.queue", { id: "thread", text: "hello", attachments: [], requestKey: expect.any(String) }]],
  },
  { name: "names the image when only an image is sent", text: "", attachments: ["/a/shot.png"], expected: start(false, { prompt: "See the attached image.", attachments: ["/a/shot.png"] }) },
  { name: "asks for work when nothing is written", text: "", expected: start(false, { prompt: "Start working on this task." }) },
  { name: "refuses to send without a model", thread: { model: null }, expected: { error: "Choose a model first." } },
] as Array<{ name: string; thread?: Partial<ThreadSummary>; runs?: RunSpec[]; text?: string; attachments?: string[]; now?: boolean; expected: unknown }>)("$name", async ({ expected, ...options }) => {
  expect(await submit(options)).toEqual(expected);
});
