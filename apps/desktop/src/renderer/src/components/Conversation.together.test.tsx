import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AccountStatus, Project, Run, SpaceProject, SpacesStatus, ThreadAuthors, ThreadCollaboration, ThreadPerson, ThreadSummary } from "@openorc/protocol";
import { runs as runStore } from "../lib/client";
import { core } from "../lib/rpc";
import type { ComposerProps } from "./Composer";
import { Conversation } from "./Conversation";

// Window chrome some transcript cards import reads the preload's platform as the module loads.
vi.hoisted(() => void ((window as unknown as { openorc?: object }).openorc ??= { platform: "darwin" }));
const queries = vi.hoisted(() => new Map<string, unknown>());
const refetched = vi.hoisted(() => ({ count: 0 }));
const composer = vi.hoisted(() => ({ props: null as ComposerProps | null }));
vi.mock("../lib/rpc", () => ({
  core: new Proxy({ call: vi.fn() } as Record<string, unknown>, { get: (target, key: string) => (key in target ? target[key] : () => () => undefined) }),
}));
vi.mock("../lib/client", async (original) => ({
  ...(await original<object>()),
  useRpc: (method: string, _params: unknown, options?: { enabled?: boolean }) => {
    const value = options?.enabled === false ? undefined : queries.get(method);
    const failed = value instanceof Error;
    return { data: failed ? undefined : value, isLoading: false, isPending: false, isError: failed, error: failed ? value : null, refetch: () => void refetched.count++ };
  },
}));
vi.mock("./Composer", async (original) => ({
  ...(await original<object>()),
  Composer: (props: ComposerProps) => {
    composer.props = props;
    return props.notices;
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

const MARA: ThreadPerson = { id: "u-mara", name: "Mara Okafor", image: null };
const THEO: ThreadPerson = { id: "u-theo", name: "Theo Laurent", image: null };
const project = { id: "project", name: "project", rootPath: "/tmp/project" } as Project;
const RUN = "hosted:cloud";
const PROMPT = "user-00000000-0000-4000-8000-000000000001";
const JOINED = "user-00000000-0000-4000-8000-000000000002";

/** Today's server: shared writing closed, the reader named. */
const together = (viewer: ThreadPerson, more: Partial<ThreadCollaboration> = {}): ThreadCollaboration => ({
  viewer,
  canWrite: false,
  live: null,
  send: "blocked",
  handoff: null,
  canPostNote: false,
  canStop: false,
  ask: null,
  queue: [],
  mentions: { unread: false, firstUnreadNoteId: null },
  noteHead: 0,
  ...more,
});

const marasThread = (collaboration: ThreadCollaboration, overrides: Partial<ThreadSummary> = {}) =>
  ({
    id: "cloud",
    projectId: "project",
    title: "Export the log",
    agent: "codex",
    model: "gpt",
    effort: null,
    fastMode: false,
    mode: "act",
    permissionMode: "trusted",
    workspaceMode: "worktree",
    activity: "idle",
    session: { status: "idle", message: null },
    queued: [],
    hasStarted: true,
    owner: { brain: "hosted", reach: "live", heardAt: 1, startedBy: { name: "Mara Okafor", image: null }, collaboration },
    ...overrides,
  }) as unknown as ThreadSummary;

const ownThread = (collaboration: ThreadCollaboration) => ({ ...marasThread(collaboration), owner: { brain: "hosted", reach: "live", heardAt: 1, collaboration } }) as ThreadSummary;

const account: AccountStatus = {
  state: "signed-in",
  email: "theo@example.com",
  name: "Theo Laurent",
  image: null,
  reach: "live",
  plan: { pro: true, standing: "live", at: 0 },
  hours: { leftSeconds: 3600, monthly: { grantedSeconds: 3600, leftSeconds: 3600, resetsAt: 0 }, packsLeftSeconds: 0 },
  sandbox: null,
  signIns: [{ agent: "codex", provider: "openai", label: "ChatGPT", ended: false }],
  signingIn: {},
  github: null,
  connectingGithub: null,
  paying: null,
  projects: [],
  error: null,
};
const spaces: SpacesStatus = {
  state: "ready",
  userId: "u-theo",
  apiOrigin: "https://api.example.com",
  personalSpaceId: "personal",
  spaces: [{ kind: "personal", id: "personal" }],
  create: { allowed: true, reason: null },
  invitations: [],
  reach: "live",
  heardAt: 1,
  error: null,
};
const catalog: SpaceProject[] = [{ key: "project", localProjectId: "project", hostedProjectId: "server-project", name: "project", repo: "sample/project", connected: true }];

const events = [
  { type: "message.completed", runId: RUN, eventId: "cloud.1", ts: 1, messageId: PROMPT, role: "user", text: "Add a CSV export" },
  { type: "message.completed", runId: RUN, eventId: "cloud.2", ts: 2, messageId: "reply-1", role: "assistant", text: "The export keeps the date first." },
  { type: "message.completed", runId: RUN, eventId: "cloud.3", ts: 3, messageId: JOINED, role: "user", text: "Keep the date first" },
  { type: "message.completed", runId: RUN, eventId: "cloud.4", ts: 4, messageId: "reply-2", role: "assistant", text: "Kept." },
  { type: "turn.completed", runId: RUN, eventId: "cloud.5", ts: 5, turnId: "t1", status: "success", durationMs: 1000 },
];

async function open(thread: ThreadSummary, authors?: ThreadAuthors | Error) {
  queries.set("account.status", account);
  queries.set("spaces.status", spaces);
  queries.set("spaces.projects", catalog);
  if (authors) queries.set("threads.authors", authors);
  queries.set("runs.listForThread", [
    { id: RUN, threadId: "cloud", taskId: null, agent: "codex", model: "gpt", mode: "act", permissionMode: "trusted", state: "success", startedAt: 1, endedAt: 2 } as unknown as Run,
  ]);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Conversation scope={{ kind: "thread", thread }} project={project} />
    </QueryClientProvider>,
  );
  for (let i = 0; i < 6; i++) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
  act(() => runStore.flush());
}

beforeEach(() => {
  runStore.reset();
  queries.clear();
  refetched.count = 0;
  composer.props = null;
  vi.mocked(core.call).mockReset();
  vi.mocked(core.call).mockImplementation((async (method: string) => (method === "events.page" ? { events: structuredClone(events), fromTurn: 0, live: false } : undefined)) as never);
});
afterEach(cleanup);

it("blocks a teammate's composer in the designed words on today's server, on the card and on demand", async () => {
  await open(marasThread(together(THEO, { live: { id: "t1", sender: MARA, startedAt: 0, stopping: false } }), { activity: "running" }));
  const words = "Only Mara can run the agent in this cloud thread for now.";
  expect(composer.props!.readOnlyReason).toBe(words);
  expect(composer.props!.disabledReason).toBe(words);
  expect(screen.getByRole("status", { name: "OpenOrc Cloud" }).textContent).toBe(words);
  act(() => composer.props!.onReady?.());
  await act(async () => undefined);
  expect(vi.mocked(core.call).mock.calls.map(([method]) => method)).not.toContain("threads.ready");
});

it("reads the server's own block before any words of the app's", async () => {
  const handoff = { code: "handoff_save" as const, message: "The thread's work could not be saved. Mara can retry the save.", responsible: MARA, commandIds: [], retrySave: false };
  await open(marasThread(together(THEO, { canWrite: true, send: "blocked", handoff })));
  expect(composer.props!.readOnlyReason).toBe(handoff.message);
});

it("lets the next sender stop the command that holds their turn, from the card that says so", async () => {
  const handoff = { code: "handoff_command" as const, message: "Mara's command is still running. Stop it before starting your turn.", responsible: MARA, commandIds: ["c1"], retrySave: false };
  await open(marasThread(together(THEO, { canWrite: true, send: "blocked", handoff })));
  const card = screen.getByRole("status", { name: "OpenOrc Cloud" });
  expect(card.textContent).toBe(`${handoff.message}Stop command`);
  vi.mocked(core.call).mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Stop command" }));
  await act(async () => undefined);
  expect(
    vi
      .mocked(core.call)
      .mock.calls.filter(([method]) => method === "threads.stopCommand")
      .map(([, params]) => params),
  ).toEqual([{ id: "cloud", commandId: "c1" }]);
});

it("offers Retry save to the person the server lets ask, without telling them they can, and only says whose it is to others", async () => {
  const words = "The thread's work could not be saved. Mara can retry the save.";
  const handoff = { code: "handoff_save" as const, message: words, responsible: MARA, commandIds: [], retrySave: true };
  await open(marasThread(together(MARA, { canWrite: true, send: "now", handoff })));
  expect(screen.getByRole("status", { name: "OpenOrc Cloud" }).textContent).toBe("The thread's work could not be saved.Retry save");
  vi.mocked(core.call).mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
  await act(async () => undefined);
  expect(
    vi
      .mocked(core.call)
      .mock.calls.filter(([method]) => method === "threads.retrySave")
      .map(([, params]) => params),
  ).toEqual([{ threadId: "cloud" }]);
  cleanup();
  await open(marasThread(together(THEO, { canWrite: true, send: "blocked", handoff: { ...handoff, retrySave: false } })));
  expect(screen.getByRole("status", { name: "OpenOrc Cloud" }).textContent).toBe(words);
  expect(screen.queryByRole("button", { name: "Retry save" })).toBeNull();
});

it("opens a teammate's composer by itself once the server says they may write", async () => {
  await open(marasThread(together(THEO, { canWrite: true, send: "now", canStop: true })));
  expect(composer.props!.readOnlyReason).toBeNull();
  expect(composer.props!.disabledReason).toBeNull();
  expect(screen.queryByRole("status", { name: "OpenOrc Cloud" })).toBeNull();
});

it("changes nothing in the reader's own cloud thread while the server keeps shared writing closed", async () => {
  await open(ownThread(together(THEO)), { viewer: THEO, turnOf: { [PROMPT]: "t1", "reply-1": "t1" }, senders: { t1: THEO }, authors: { [PROMPT]: THEO } });
  expect(composer.props!.readOnlyReason).toBeNull();
  expect(composer.props!.disabledReason).toBeNull();
  expect(screen.queryByRole("status", { name: "OpenOrc Cloud" })).toBeNull();
  expect(document.querySelector(".turn-head-sender, .prompt-author")).toBeNull();
});

it("names each turn's sender beside its agent and each message's author above it", async () => {
  const authors: ThreadAuthors = {
    viewer: THEO,
    turnOf: { [PROMPT]: "t1", "reply-1": "t1", [JOINED]: "t1", "reply-2": "t1" },
    senders: { t1: MARA },
    authors: { [PROMPT]: MARA, [JOINED]: THEO },
  };
  await open(marasThread(together(THEO)), authors);
  expect([...document.querySelectorAll(".prompt-author")].map((each) => each.textContent)).toEqual(["MOMara Okafor", "TLTheo Laurent"]);
  const senders = [...document.querySelectorAll(".turn-head-sender")];
  // Theo's message joined Mara's turn: the reply after it is still her turn, on her sign-in.
  expect(senders.map((each) => each.textContent)).toEqual(["MOMara", "MOMara"]);
  expect(senders[0]!.getAttribute("data-tip")).toBe("Mara Okafor");
});

it("says when who sent each turn could not be read, and reads again on Try again", async () => {
  await open(marasThread(together(THEO)), new Error("Try again."));
  expect(screen.getAllByRole("status", { name: "OpenOrc Cloud" }).map((each) => each.textContent)).toContain("Couldn't read who sent each turn.Try again");
  expect(document.querySelector(".turn-head-sender")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(refetched.count).toBe(1);
});

it("tells the ask dock whose ask it is and why the reader cannot answer it", async () => {
  const ask = { id: "a1", turnId: "t1", state: "waiting" as const, sender: MARA, answer: "blocked" as const, canDecline: false, reason: "Mara Okafor can answer while this turn is running." };
  await open(marasThread(together(THEO, { ask }), { activity: "waiting" }));
  expect(composer.props!.asksLabel).toBe("Waiting on Mara");
  expect(composer.props!.asksBlocked).toBe("Mara Okafor can answer while this turn is running.");
});

it("tells the ask dock that answering Mara's parked ask continues on the reader's own sign-in and hours", async () => {
  const ask = { id: "a1", turnId: "t1", state: "parked" as const, sender: MARA, answer: "start" as const, canDecline: true, reason: null };
  await open(marasThread(together(THEO, { canWrite: true, send: "now", ask }), { activity: "waiting" }));
  expect(composer.props!.asksBlocked).toBeNull();
  expect(composer.props!.askContinues?.("a1")).toBe("Continues with your sign-in and hours.");
  expect(composer.props!.askContinues?.("another")).toBeNull();
});

const handoff = { code: "handoff_unavailable" as const, message: "Only Mara can run the agent in this cloud thread for now.", responsible: MARA, commandIds: [], retrySave: false };
const joining = (more: Partial<ThreadCollaboration> = {}) => together(THEO, { canWrite: true, send: "now", handoff, live: { id: "t2", sender: MARA, startedAt: 0, stopping: false }, ...more });

it("opens a teammate's composer to join Mara's running turn, with Queue and Stop as the server says", async () => {
  await open(marasThread(joining(), { activity: "running" }));
  expect(composer.props!.readOnlyReason).toBeNull();
  expect(composer.props!.sendPayer).toMatchObject({ now: "Joins Mara's turn, on their sign-in and hours.", stop: "Stop Mara's turn" });
  expect(composer.props!.queueBlocked).toBe(handoff.message);
  expect(composer.props!.canStopTurn).toBe(false);
  expect(screen.queryByRole("status", { name: "OpenOrc Cloud" })).toBeNull();
});

it("blocks a teammate's composer between turns in the server's words", async () => {
  await open(marasThread(joining({ send: "blocked", live: null })));
  expect(composer.props!.readOnlyReason).toBe(handoff.message);
  expect(screen.getByRole("status", { name: "OpenOrc Cloud" }).textContent).toBe(handoff.message);
});

it("holds Send now while Mara's turn is stopping", async () => {
  await open(marasThread(joining({ send: "after", live: { id: "t2", sender: MARA, startedAt: 0, stopping: true } }), { activity: "running" }));
  expect([composer.props!.steerable, composer.props!.steerReason]).toEqual([false, "This turn is stopping."]);
});

it("keeps a join that missed its turn paused for its author, Start turn dimmed in the server's words", async () => {
  const queue = [{ messageId: "late", author: THEO, paused: true, canEdit: true, canRemove: true, canStart: false }];
  await open(marasThread(joining({ send: "blocked", live: null, queue }), { queued: [{ id: "late", text: "Keep the date first", attachments: [], queuedAt: 1 }] }));
  fireEvent.click(screen.getByRole("button", { name: /1 paused/ }));
  const start = screen.getByRole("button", { name: "Start turn" });
  expect([start.hasAttribute("disabled"), start.getAttribute("data-tip")]).toEqual([true, handoff.message]);
  expect(screen.getByRole("button", { name: "Remove queued message 1" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
});

it("never makes a shared thread ready on focus alone, only once there are words", async () => {
  await open(marasThread(together(THEO, { canWrite: true, send: "now" })));
  act(() => composer.props!.onReady?.("focus"));
  await act(async () => undefined);
  expect(vi.mocked(core.call).mock.calls.map(([method]) => method)).not.toContain("threads.ready");
  act(() => composer.props!.onReady?.("words"));
  await act(async () => undefined);
  expect(vi.mocked(core.call).mock.calls.map(([method]) => method)).toContain("threads.ready");
});
