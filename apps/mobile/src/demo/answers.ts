import type { InboxItem, RemoteMethod, RpcParams, RpcResults, SessionMethod, SessionParams, SessionRpcResults, ThreadMessage, ThreadSummary, WorkspaceChanges } from "@openorc/protocol";
import type { DemoCore } from "./core";
import { demoAccounts, demoAvailability, demoLimits, demoModels, demoSettings } from "./mac";
import { storyThread } from "./story";

type Answers = { [M in RemoteMethod]: (core: DemoCore, params: RpcParams<M>) => RpcResults[M] };

const NO_CHANGES: WorkspaceChanges = { comparison: "head", baseSha: null, totals: { files: 0, insertions: 0, deletions: 0 }, files: [], unlisted: 0 };

function listed(core: DemoCore, params: RpcParams<"threads.list">): ThreadSummary[] {
  const filter = params.filter ?? "active";
  const offset = params.offset ?? 0;
  return [...core.threads.values()]
    .filter((thread) => !params.projectId || thread.projectId === params.projectId)
    .filter((thread) => filter === "all" || (filter === "archived") === (thread.archivedAt !== null))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(offset, offset + (params.limit ?? 50));
}

function messages(core: DemoCore, threadId: string): ThreadMessage[] {
  return [...core.runs.values()]
    .filter(({ run }) => run.threadId === threadId)
    .flatMap(({ events }) => events.flatMap((event) => (event.type === "message.completed" ? [{ id: event.messageId, role: event.role, text: event.text, createdAt: event.ts }] : [])));
}

function inbox(core: DemoCore): InboxItem[] {
  return [...core.threads.values()].flatMap((thread): InboxItem[] =>
    thread.activity === "waiting" && thread.liveRunId ? [{ kind: "thread", thread, runId: thread.liveRunId, reason: "approval", detail: "pnpm build" }] : [],
  );
}

/** What changed in a thread: its worktree against its base by default, as the core measures it. */
function changes(core: DemoCore, { threadId, comparison }: RpcParams<"review.threadChanges">): WorkspaceChanges {
  const workspace = core.workspaces.get(threadId);
  return workspace ? workspace.changes(comparison ?? "base") : NO_CHANGES;
}

function patch(core: DemoCore, { id, patch: change }: RpcParams<"threads.update">): ThreadSummary {
  const thread = core.thread(id);
  const now = core.clock.now();
  /** When a switch turned on: now, null once off, or as it was when the patch leaves it. */
  const stamp = (on: boolean | undefined, at: number | null) => {
    if (on === undefined) return at;
    return on ? now : null;
  };
  const { seen, pinned, archived, done, title, snoozedUntil, draft, mode, permissionMode, model, effort } = change;
  return core.update(id, {
    ...(title ? { title } : {}),
    ...(mode ? { mode } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(draft !== undefined ? { draft } : {}),
    ...(snoozedUntil !== undefined ? { snoozedUntil } : {}),
    ...(seen === undefined ? {} : { unread: !seen, seenAt: seen ? now : thread.seenAt }),
    pinnedAt: stamp(pinned, thread.pinnedAt),
    archivedAt: stamp(archived, thread.archivedAt),
    doneAt: stamp(done, thread.doneAt),
  });
}

/**
 * The demo Mac's answer to every method a phone may call, typed over REMOTE_METHODS: a method added for phones does
 * not compile until the demo answers it. Writes change only the demo Mac's memory.
 */
const answers: Answers = {
  "projects.list": (core) => core.projects,
  "projects.get": (core, { id }) => core.projects.find((project) => project.id === id) ?? null,
  "projects.git": () => "ready",
  "threads.list": listed,
  "threads.get": (core, { id }) => core.threads.get(id) ?? null,
  // Messages said outside any run, as other threads leave them; the demo's threads have none, and its runs say the rest.
  "threads.messages": (core, { id }) => {
    core.thread(id);
    return [];
  },
  "threads.lastMessage": (core, { id }) => messages(core, id).at(-1) ?? null,
  "runs.listForThread": (core, { threadId }) => [...core.runs.values()].filter(({ run }) => run.threadId === threadId).map(({ run }) => run),
  "events.page": (core, { runId }) => {
    const run = core.demoRun(runId);
    return { events: run.events, fromTurn: 0, live: run.live };
  },
  "events.toolOutput": (core, { runId, toolCallId }) => {
    const done = core.demoRun(runId).events.find((event) => event.type === "tool.completed" && event.toolCallId === toolCallId);
    return { output: done?.type === "tool.completed" ? done.output : null };
  },
  "inbox.list": (core) => ({ items: inbox(core) }),
  "agents.models": (_core, { agent }) => demoModels.filter((model) => !agent || model.agent === agent),
  "agents.availability": () => demoAvailability,
  "claude.accounts.list": (core) => demoAccounts(core.started),
  "providers.limits": (core) => demoLimits(core.clock.now()),
  "app.settings.get": () => demoSettings,
  "threads.start": (core, params) => {
    const id = core.id("demo-thread");
    const title = params.title ?? params.prompt.split("\n")[0]!.slice(0, 60);
    const { agent = "claude", model = null, effort = null, mode, permissionMode } = params;
    core.threads.set(id, { ...storyThread(core.clock.now(), id, params.projectId, title, 0, { agent, model, effort, mode, permissionMode }), createdAt: core.clock.now() });
    const run = core.startRun(id, params.prompt, params.attachments);
    return { thread: core.thread(id), run };
  },
  "threads.update": patch,
  "runs.start": (core, { threadId, prompt, attachments }) => {
    if (!threadId) throw new Error("Start a run from its thread.");
    return core.startRun(threadId, prompt, attachments);
  },
  "runs.send": (core, { runId, text, attachments }) => {
    core.reply(core.demoRun(runId).player, text, attachments);
    return null;
  },
  "runs.interrupt": (core, { runId }) => {
    core.demoRun(runId).player.interrupt();
    return null;
  },
  "threads.queue": (core, { id, text, attachments }) => core.queue(id, text, attachments),
  "threads.unqueue": (core, { id, messageId }) => core.update(id, { queued: core.thread(id).queued.filter((queued) => queued.id !== messageId) }).queued,
  "threads.sendQueued": (core, { id, messageId }) => {
    const thread = core.thread(id);
    const sent = thread.queued.find((queued) => queued.id === messageId);
    const live = core.liveRun(id);
    if (sent && live) core.reply(live.player, sent.text, sent.attachments);
    return core.update(id, { queued: thread.queued.filter((queued) => queued !== sent) }).queued;
  },
  "approvals.resolve": (core, { runId, approvalId, decision }) => {
    if (!core.demoRun(runId).player.resolve(approvalId, decision)) throw new Error("This approval was already answered.");
    return null;
  },
  "attachments.save": (core, { name, dataBase64 }) => {
    const stored = `${core.id("image")}-${name}`;
    core.attachments.set(
      stored,
      Uint8Array.from(atob(dataBase64), (char) => char.charCodeAt(0)),
    );
    return { path: `/Users/demo/.openorc/attachments/${stored}`, url: `openorc-attachment://${stored}` };
  },
  "review.threadChanges": changes,
  "review.threadFileDiff": (core, { threadId, comparison, path }) => {
    const workspace = core.workspaces.get(threadId);
    if (!workspace) throw new Error("This file has no changes.");
    return workspace.fileDiff(comparison ?? "base", path);
  },
  "git.threadLog": (core, { threadId, limit }) => core.workspaces.get(threadId)?.commits(limit ?? 50) ?? [],
  "git.threadPushState": (core, { threadId }) =>
    core.workspaces.get(threadId)?.pushState() ?? { branch: null, blocked: "This thread works in the project's checkout.", published: false, unpushedCount: 0, unpushed: [], busy: false },
  "review.threadPrTemplate": () => ({ body: null }),
  "pulls.branches": () => ({ branches: ["main"], defaultBranch: "main" }),
  "system.gh": () => ({ installed: false }),
  "review.commitThread": (core, { threadId, message }) => {
    const commit = core.workspaces.get(threadId)?.commit(message, core.clock.now());
    if (!commit) throw new Error("Nothing to commit.");
    core.invalidate(["workspace-diff", `threaddiff:${threadId}`, `threadlog:${threadId}`]);
    return { sha: commit.sha };
  },
  "review.pushThread": (core, { threadId }) => {
    const pushed = core.workspaces.get(threadId)?.push();
    if (!pushed) throw new Error("This thread has no branch to push.");
    core.invalidate([`threadlog:${threadId}`]);
    return pushed;
  },
  "review.createThreadPr": () => {
    throw new Error("GitHub's gh is not installed on this Mac.");
  },
  "preview.state": (core, { threadId }) => core.previews.get(threadId) ?? { open: false },
};

export function answerDemo<M extends RemoteMethod>(core: DemoCore, method: M, params: RpcParams<M>): RpcResults[M] {
  return answers[method](core, params);
}

/** Preview's session methods: the one page the demo shows, which input never changes. */
export function answerSession<M extends SessionMethod>(core: DemoCore, method: M, params: SessionParams<M>): SessionRpcResults[M] {
  const results: { [K in SessionMethod]: (params: SessionParams<K>) => SessionRpcResults[K] } = {
    "preview.watch": ({ threadId }) => core.previews.get(threadId) ?? { open: false },
    "preview.unwatch": () => null,
    "preview.input": () => ({ focus: null }),
  };
  return results[method](params);
}
