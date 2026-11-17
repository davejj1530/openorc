import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AccountStatus, Project, Run, SpaceProject, SpacesStatus, ThreadAuthors, ThreadCollaboration, ThreadPerson, ThreadSummary } from "@openorc/protocol";
import { runs as runStore } from "../lib/client";
import { core } from "../lib/rpc";
import type { ComposerProps } from "./Composer";
import { Conversation } from "./Conversation";
import { useMentionReveal } from "./ThreadNotes";
import { spaceNavigation } from "../lib/space-navigation";

// Window chrome some transcript cards import reads the preload's platform as the module loads.
vi.hoisted(() => void ((window as unknown as { openorc?: object }).openorc ??= { platform: "darwin" }));
const queries = vi.hoisted(() => new Map<string, unknown>());
const refetched = vi.hoisted(() => ({ count: 0 }));
const reads = vi.hoisted(() => [] as { method: string; params: unknown; enabled: boolean }[]);
const watched = vi.hoisted(() => [] as ((entries: { target: Element; isIntersecting: boolean }[]) => void)[]);
const composer = vi.hoisted(() => ({ props: null as ComposerProps | null, handle: { append: () => {}, tag: (_person: unknown, _replyTo?: string) => {}, note: vi.fn() } }));
vi.mock("../lib/rpc", () => ({
  core: new Proxy({ call: vi.fn() } as Record<string, unknown>, { get: (target, key: string) => (key in target ? target[key] : () => () => undefined) }),
}));
vi.mock("../lib/client", async (original) => ({
  ...(await original<object>()),
  useRpc: (method: string, params: unknown, options?: { enabled?: boolean }) => {
    reads.push({ method, params, enabled: options?.enabled !== false });
    const value = options?.enabled === false ? undefined : queries.get(method);
    const failed = value instanceof Error;
    return { data: failed ? undefined : value, isLoading: false, isPending: false, isError: failed, error: failed ? value : null, refetch: () => void refetched.count++ };
  },
}));
vi.mock("./Composer", async (original) => ({
  ...(await original<object>()),
  Composer: (props: ComposerProps) => {
    composer.props = props;
    if (props.handle && typeof props.handle === "object") (props.handle as { current: unknown }).current = composer.handle;
    return props.notices;
  },
}));
vi.mock("./AgentOrb", () => ({ AgentOrb: () => null }));
Object.assign(globalThis, {
  IntersectionObserver: class {
    constructor(seen: (entries: { target: Element; isIntersecting: boolean }[]) => void) {
      watched.push(seen);
    }
    observe() {}
    unobserve() {}
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
  reads.length = 0;
  watched.length = 0;
  composer.props = null;
  vi.mocked(core.call).mockReset();
  vi.mocked(core.call).mockImplementation((async (method: string) => (method === "events.page" ? { events: structuredClone(events), fromTurn: 0, live: false } : undefined)) as never);
});
afterEach(() => {
  cleanup();
  spaceNavigation.setState({ inventory: [] });
});

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
  const handoff = {
    code: "handoff_save" as const,
    message: "The thread's work could not be saved. Mara can retry the save.",
    responsible: MARA,
    commandIds: [],
    retrySave: false,
    stopWork: false,
    note: null,
  };
  await open(marasThread(together(THEO, { canWrite: true, send: "blocked", handoff })));
  expect(composer.props!.readOnlyReason).toBe(handoff.message);
});

it("lets the next sender stop the command that holds their turn, from the card that says so", async () => {
  const handoff = {
    code: "handoff_command" as const,
    message: "Mara's command is still running. Stop it before starting your turn.",
    responsible: MARA,
    commandIds: ["c1"],
    retrySave: false,
    stopWork: false,
    note: null,
  };
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

it("names a teammate's open terminal for what it is on the card's Stop, which ends it as a command's Stop does", async () => {
  const handoff = {
    code: "handoff_command" as const,
    message: "Mara's terminal is still open. Stop it before starting your turn.",
    responsible: MARA,
    commandIds: ["terminal-1"],
    retrySave: false,
    stopWork: false,
    note: null,
  };
  await open(marasThread(together(THEO, { canWrite: true, send: "blocked", handoff })));
  expect(screen.getByRole("status", { name: "OpenOrc Cloud" }).textContent).toBe(`${handoff.message}Stop terminal`);
  vi.mocked(core.call).mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Stop terminal" }));
  await act(async () => undefined);
  expect(
    vi
      .mocked(core.call)
      .mock.calls.filter(([method]) => method === "threads.stopCommand")
      .map(([, params]) => params),
  ).toEqual([{ id: "cloud", commandId: "terminal-1" }]);
});

it("offers Retry save to the person the server lets ask, without telling them they can, and only says whose it is to others", async () => {
  const words = "The thread's work could not be saved. Mara can retry the save.";
  const handoff = { code: "handoff_save" as const, message: words, responsible: MARA, commandIds: [], retrySave: true, stopWork: false, note: null };
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

it("offers one of the thread's people Stop work for the work that reports back, which starts nothing", async () => {
  const words = "Mara's turn left work running here.";
  const handoff = { code: "handoff_unavailable" as const, message: words, responsible: MARA, commandIds: [], retrySave: false, stopWork: true, note: null };
  await open(marasThread(together(THEO, { canWrite: true, send: "blocked", handoff })));
  expect(screen.getByRole("status", { name: "OpenOrc Cloud" }).textContent).toBe(`${words}Stop work`);
  vi.mocked(core.call).mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Stop work" }));
  await act(async () => undefined);
  expect(
    vi
      .mocked(core.call)
      .mock.calls.filter(([method]) => method === "threads.stopWork")
      .map(([, params]) => params),
  ).toEqual([{ threadId: "cloud" }]);
});

it("offers a teammate with nothing else to press the server's note, which opens in the composer", async () => {
  const note = { to: MARA, text: "@Mara the thread's work could not be saved. Can you retry the save?", mention: { start: 0, end: 5 } };
  const words = "The thread's work could not be saved. Mara can retry the save.";
  const handoff = { code: "handoff_save" as const, message: words, responsible: MARA, commandIds: [], retrySave: false, stopWork: false, note };
  await open(marasThread(together(THEO, { canWrite: true, send: "blocked", handoff })));
  expect(screen.getByRole("status", { name: "OpenOrc Cloud" }).textContent).toBe(`${words}Tag Mara`);
  fireEvent.click(screen.getByRole("button", { name: "Tag Mara" }));
  expect(composer.handle.note).toHaveBeenCalledWith(note);
  cleanup();
  // While the composer holds that note, it is posted from there: the card says why and offers no second Tag.
  await open(marasThread(together(THEO, { canWrite: true, send: "blocked", handoff }), { draft: `@[user:${MARA.id}] the thread's work could not be saved. Can you retry the save?` }));
  expect(screen.getByRole("status", { name: "OpenOrc Cloud" }).textContent).toBe(words);
  expect(screen.queryByRole("button", { name: "Tag Mara" })).toBeNull();
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

it("names the reader's own messages in an organization's thread, which its project's members read, and leaves their turns' sender to them", async () => {
  const thread = ownThread(together(THEO));
  spaceNavigation.setState({ inventory: [{ id: "altalogy", personal: false, projects: [], threads: [{ id: thread.id, projectId: thread.projectId }], taskIds: [] }] });
  await open(thread, { viewer: THEO, turnOf: { [PROMPT]: "t1", "reply-1": "t1" }, senders: { t1: THEO }, authors: { [PROMPT]: THEO } });
  expect(document.querySelector(".turn-head-sender")).toBeNull();
  expect([...document.querySelectorAll(".prompt-author")].map((each) => each.textContent)).toEqual(["TLTheo Laurent"]);
});

it("names each message's author above it, and a turn's sender where its prompt does not", async () => {
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
  expect(senders.map((each) => each.textContent)).toEqual(["MOMara"]);
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

it("draws a teammate's note in the thread with the person it tags, and Reply puts its author's tag in the draft", async () => {
  queries.set("threads.notes", {
    notes: [
      {
        id: "n1",
        seq: 1,
        author: MARA,
        text: "@Theo Laurent Can you check the column order?",
        mentions: [{ person: THEO, userId: THEO.id, start: 0, end: 13 }],
        replyTo: null,
        createdAt: "2026-11-15T10:00:00.000Z",
        afterEventSeq: 0,
        mentionedYou: true,
        read: false,
      },
    ],
    head: 1,
    hasBefore: false,
    hasAfter: false,
  });
  await open(marasThread(together(THEO, { canWrite: true, send: "now", canPostNote: true, noteHead: 1 })));
  const note = screen.getByRole("article", { name: "Note from Mara Okafor" });
  expect(note.textContent).toContain("Note");
  expect(note.querySelector(".person-token")?.textContent).toBe("@Theo Laurent");
  const tag = vi.spyOn(composer.handle, "tag");
  fireEvent.click(within(note).getByRole("button", { name: "Reply" }));
  expect(tag).toHaveBeenCalledWith(MARA, "n1");
});

it("posts a tagged draft as the reader's note, the same note again after a lost answer, and offers none until the server lets them", async () => {
  await open(marasThread(together(THEO, { canWrite: true, send: "now" })));
  expect(composer.props!.notes).toBeNull();
  cleanup();
  await open(marasThread(together(THEO, { canWrite: true, send: "now", canPostNote: true })));
  expect(composer.props!.notes).toMatchObject({ threadId: "cloud", viewerId: THEO.id });
  const note = { text: "@Mara Okafor The columns match.", mentions: [{ userId: MARA.id, start: 0, end: 12 }] };
  vi.mocked(core.call).mockImplementationOnce((async () => Promise.reject(new Error("The server could not be reached."))) as never);
  await expect(act(() => composer.props!.notes!.post(note))).rejects.toThrow("The server could not be reached.");
  await act(() => composer.props!.notes!.post(note));
  const posts = vi
    .mocked(core.call)
    .mock.calls.filter(([method]) => method === "threads.postNote")
    .map(([, params]) => params as { id: string });
  expect(posts).toEqual([expect.objectContaining({ threadId: "cloud", ...note }), expect.objectContaining({ threadId: "cloud", ...note })]);
  expect(posts[0]!.id).toBe(posts[1]!.id);
});

const marasNote = {
  id: "n1",
  seq: 1,
  author: MARA,
  text: "@Theo Laurent Can you check the column order?",
  mentions: [{ person: THEO, userId: THEO.id, start: 0, end: 13 }],
  replyTo: null,
  createdAt: "2026-11-15T10:00:00.000Z",
  afterEventSeq: 0,
  mentionedYou: true,
  read: false,
};

it("asks today's server for no notes, people or reading, which it says it has none of", async () => {
  queries.set("threads.notes", { notes: [marasNote], head: 1, hasBefore: false, hasAfter: false });
  await open(marasThread(together(THEO, { canWrite: true, send: "now" })));
  const asked = reads.filter((read) => read.enabled && ["threads.notes", "threads.people"].includes(read.method));
  expect(asked).toEqual([]);
  expect(composer.props!.notes).toBeNull();
  expect(screen.queryByRole("article")).toBeNull();
  expect(vi.mocked(core.call).mock.calls.map(([method]) => method)).not.toContain("threads.readNotes");
});

it("opens at the reader's first unread mention, reading the notes around it, and marks it read once seen in the focused window", async () => {
  queries.set("threads.notes", { notes: [marasNote], head: 1, hasBefore: false, hasAfter: false });
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  await open(marasThread(together(THEO, { canWrite: true, send: "now", noteHead: 1, mentions: { unread: true, firstUnreadNoteId: "n1" } })));
  expect(reads).toContainEqual({ method: "threads.notes", params: { threadId: "cloud", around: "n1", limit: 200 }, enabled: true });
  const note = screen.getByRole("article", { name: "Note from Mara Okafor" });
  expect(note.dataset["message"]).toBe("n1");
  expect(vi.mocked(core.call).mock.calls.map(([method]) => method)).not.toContain("threads.readNotes");
  act(() => watched.forEach((seen) => seen([{ target: note, isIntersecting: true }])));
  await act(() => new Promise((resolve) => setTimeout(resolve, 450)));
  expect(vi.mocked(core.call)).toHaveBeenCalledWith("threads.readNotes", { threadId: "cloud", ids: ["n1"] });
  focus.mockRestore();
});

it("brings the first unread mention into view once as the thread opens, not again as notes are read or come", () => {
  const thread = (firstUnreadNoteId: string | null, id = "cloud") => marasThread(together(THEO, { noteHead: 1, mentions: { unread: Boolean(firstUnreadNoteId), firstUnreadNoteId } }), { id });
  const { result, rerender } = renderHook(({ shown }) => useMentionReveal(shown), { initialProps: { shown: thread("n1") } });
  const first = result.current;
  expect(first).toEqual({ messageId: "n1" });
  rerender({ shown: thread(null) });
  expect(result.current).toBe(first);
  rerender({ shown: thread("n4", "other") });
  expect(result.current).toEqual({ messageId: "n4" });
  rerender({ shown: thread(null, "next") });
  expect(result.current).toBeUndefined();
});

const handoff = {
  code: "handoff_unavailable" as const,
  message: "Mara's turn left work running here.",
  responsible: MARA,
  commandIds: [],
  retrySave: false,
  stopWork: false,
  note: null,
};
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
  const pause = { kind: "join", message: "The turn this was sent to has ended." };
  const queue = [{ messageId: "late", author: THEO, paused: true, canEdit: true, canRemove: true, canStart: false, task: null, pause }];
  await open(marasThread(joining({ send: "blocked", live: null, queue }), { queued: [{ id: "late", text: "Keep the date first", attachments: [], queuedAt: 1 }] }));
  // The pile says why it waits, in the server's words.
  expect(screen.getByRole("button", { name: /1 paused/ }).textContent).toContain(pause.message);
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
