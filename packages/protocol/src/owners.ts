import type { Task, ThreadFilter, ThreadSummary } from "./domain.js";
import type { InboxItem, InboxList, RpcMethod, RpcParams } from "./rpc.js";
import type { Brain, OwnerReach } from "./thread-owner.js";

/**
 * Every method whose params name a thread (`threadId`, or `id` on a threads.* method), a run (`runId`) or a task
 * (`taskId`, or `id` on a tasks.* method). Derived from the schemas, so a new such method does not compile until
 * OWNER_ROUTES says how it routes.
 */
type NamesThreadOrRun<M extends RpcMethod, P = RpcParams<M>> = string extends keyof P
  ? never
  : "threadId" extends keyof P
    ? M
    : "runId" extends keyof P
      ? M
      : "taskId" extends keyof P
        ? M
        : M extends `threads.${string}` | `tasks.${string}`
          ? "id" extends keyof P
            ? M
            : never
          : never;
export type RoutedMethod = { [M in RpcMethod]: NamesThreadOrRun<M> }[RpcMethod];

export type OwnerRoute<M extends RpcMethod> =
  /** The thread's owner answers; a method whose thread is optional and absent is the asked host's own. */
  | { by: "owner"; thread: (params: RpcParams<M>) => string | undefined }
  /** The owner of the run's thread answers. */
  | { by: "run"; run: (params: RpcParams<M>) => string }
  /** Every brain answers its own rows; the asker merges them. Never waits on the brain. Asked about one thread, its owner answers. */
  | { by: "merge"; thread?: (params: RpcParams<M>) => string | undefined }
  /** The host holding the task answers: tasks move with the thread doing their work. */
  | { by: "task"; task: (params: RpcParams<M>) => string | undefined }
  /** Served by the asked host even for another host's thread: its folder, its preview, its windows. */
  | { by: "here" }
  /** Refused for a thread another host owns, in these words. */
  | { by: "owner-only"; thread: (params: RpcParams<M>) => string | undefined; words: string }
  /** A new thread asked for the cloud starts on the brain, on its copy of the Mac project `cloud` names; any other, here. */
  | { by: "start"; cloud: (params: RpcParams<M>) => string | undefined }
  /**
   * Readies the place a new cloud thread in the Mac project `cloud` names will start: the brain, woken for it, when it has
   * a copy of the project; else here.
   */
  | { by: "ahead"; cloud: (params: RpcParams<M>) => string | undefined };

export const BRING_FIRST = "Bring it to this Mac first.";
/** Why a project's conversations cannot start or move in the cloud while the brain has no copy of it. */
export const NOT_ON_BRAIN = "Add this project to the cloud brain in Settings > Cloud on the Mac first.";
/** Why no conversation can start or move in the cloud: no cloud service is connected to run it on. */
export const NO_CLOUD_SERVICE = "Connect Vercel or Agent37 in Settings > Cloud first.";
const IN_CLOUD = "This conversation is already in the cloud.";

const byThreadId = { by: "owner", thread: (p: { threadId?: string | undefined }) => p.threadId } as const;
const byId = { by: "owner", thread: (p: { id: string }) => p.id } as const;
const byRun = { by: "run", run: (p: { runId: string }) => p.runId } as const;
const byTask = { by: "task", task: (p: { taskId: string }) => p.taskId } as const;
const byTaskId = { by: "task", task: (p: { id: string }) => p.id } as const;
const ownerOnly = (words: string) => ({ by: "owner-only", thread: (p: { id: string }) => p.id, words }) as const;
const here = { by: "here" } as const;

/**
 * How a Mac window's call reaches a thread's owner. The Mac's router reads it; the brain derives the Mac's session
 * allowlist from it. Methods not listed and not RoutedMethod are host-level: the asked core answers about itself.
 */
export const OWNER_ROUTES: { [M in RoutedMethod]: OwnerRoute<M> } & { [M in Exclude<RpcMethod, RoutedMethod>]?: OwnerRoute<M> } = {
  "threads.start": { by: "start", cloud: (p) => (p.cloud ? p.projectId : undefined) },
  "cloud.warm": { by: "ahead", cloud: (p) => p.projectId },
  "threads.list": { by: "merge" },
  "threads.resolvedCount": { by: "merge" },
  "inbox.list": { by: "merge" },
  "threads.get": byId,
  "threads.messages": byId,
  "threads.lastMessage": byId,
  "threads.plans": byId,
  "threads.implementPlan": byId,
  "threads.exportPlan": byId,
  "threads.update": byId,
  "threads.switchClaudeAccount": byId,
  "threads.delete": byId,
  "threads.compact": byId,
  "threads.queue": byId,
  "threads.unqueue": byId,
  "threads.sendQueued": byId,
  "threads.stopCommand": byId,
  "threads.send": byId,
  "threads.checkpoints": byId,
  "threads.turnChanges": byId,
  "subagents.stop": byThreadId,
  "runs.start": byThreadId,
  "runs.listForThread": byThreadId,
  "runs.send": byRun,
  "runs.interrupt": byRun,
  "runs.close": byRun,
  "events.listForRun": byRun,
  "events.page": byRun,
  "events.toolOutput": byRun,
  "approvals.resolve": byRun,
  "tasks.list": { by: "merge", thread: (p) => p.threadId },
  "tasks.create": byThreadId,
  "tasks.get": byTaskId,
  "tasks.update": byTaskId,
  "tasks.delete": byTaskId,
  "tasks.start": byTask,
  "tasks.openThread": byTask,
  "tasks.executionThread": byTask,
  "tasks.prepareWorkspace": byTask,
  "tasks.comments.list": byTask,
  "tasks.comments.post": byTask,
  "tasks.comments.retry": byTask,
  "tasks.comments.cancel": byTask,
  "tasks.comments.execute": byTask,
  "runs.listForTask": byTask,
  "memory.forTask": byTask,
  "workspace.cleanup": byTask,
  "workspace.removalImpact": byTask,
  "workspace.usage": byTask,
  "review.diff": byTask,
  "review.snapshots": byTask,
  "review.markReviewed": byTask,
  "review.commit": byTask,
  "review.checkoutState": byTask,
  "review.exportPatch": byTask,
  "review.push": byTask,
  "review.createPr": byTask,
  "git.log": byTask,
  "review.threadChanges": byThreadId,
  "review.threadFileDiff": byThreadId,
  "review.threadDiff": byThreadId,
  "review.commitThread": byThreadId,
  "review.pushThread": byThreadId,
  "review.createThreadPr": byThreadId,
  "review.threadPrTemplate": byThreadId,
  "git.threadLog": byThreadId,
  "git.commitRange": byThreadId,
  "git.threadPushState": byThreadId,
  "review.comments.list": byThreadId,
  "review.comments.add": byThreadId,
  "review.comments.remove": byThreadId,
  "review.comments.send": byThreadId,
  // Things that change where it lives or what it is made of stay with a thread on this Mac.
  "threads.moveWorkspace": ownerOnly(BRING_FIRST),
  "threads.movePreview": ownerOnly(BRING_FIRST),
  "threads.fork": ownerOnly(BRING_FIRST),
  "threads.restore": ownerOnly(BRING_FIRST),
  "threads.restorePreview": ownerOnly(BRING_FIRST),
  "orclings.ask": { by: "owner-only", thread: (p) => p.threadId, words: BRING_FIRST },
  "orclings.assign": { by: "owner-only", thread: (p) => p.threadId, words: BRING_FIRST },
  "cloud.move": { by: "owner-only", thread: (p) => p.threadId, words: IN_CLOUD },
  // This Mac coordinates every move, whichever brain holds the thread.
  "cloud.bringToMac": here,
  "cloud.keep": here,
  "cloud.openOnMac": here,
  "cloud.closeOnMac": here,
  // Asked of the brain by the Mac's copy of a thread, never by a window.
  "threads.snapshot": here,
  // The Mac's own: a cloud thread's files come from its read-only copy here, its preview and app views from this Mac.
  "instructions.list": here,
  "instructions.save": here,
  "preview.state": here,
  "mcpApps.open": here,
};

/**
 * Routed methods that only read the thread, run or task they name. Every other routed method writes, and is refused
 * while that thread is frozen for a move, so a write the move's package would leave behind is never accepted.
 */
export const ROUTED_READS: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  "threads.list",
  "threads.resolvedCount",
  "inbox.list",
  "threads.get",
  "threads.messages",
  "threads.lastMessage",
  "threads.plans",
  "threads.checkpoints",
  "threads.turnChanges",
  "threads.movePreview",
  "threads.restorePreview",
  "runs.listForThread",
  "events.listForRun",
  "events.page",
  "events.toolOutput",
  "tasks.list",
  "tasks.get",
  "tasks.executionThread",
  "tasks.comments.list",
  "runs.listForTask",
  "memory.forTask",
  "workspace.removalImpact",
  "workspace.usage",
  "review.diff",
  "review.snapshots",
  "review.checkoutState",
  "git.log",
  "review.threadChanges",
  "review.threadFileDiff",
  "review.threadDiff",
  "review.threadPrTemplate",
  "git.threadLog",
  "git.commitRange",
  "git.threadPushState",
  "review.comments.list",
]);

/**
 * Methods only the Mac's own session asks the brain, besides those the router forwards: attached files go up before the
 * message naming them; memory, the Mac's open tasks and its text generation choice go while both are awake.
 */
const OWNER_SESSION_EXTRA: readonly RpcMethod[] = ["threads.snapshot", "attachments.save", "attachments.saveFile", "brain.memory.exchange", "brain.backlog", "brain.textGeneration"];

/** What the brain admits from its Mac's session: everything the router may forward to it, derived, never listed. */
export const OWNER_SESSION_METHODS: ReadonlySet<RpcMethod> = new Set([
  ...(Object.entries(OWNER_ROUTES) as [RpcMethod, OwnerRoute<RpcMethod>][]).filter(([, route]) => route.by !== "here" && route.by !== "owner-only").map(([method]) => method),
  ...OWNER_SESSION_EXTRA,
]);

export function ownerRoute(method: RpcMethod): OwnerRoute<RpcMethod> | undefined {
  return (OWNER_ROUTES as Partial<Record<RpcMethod, OwnerRoute<RpcMethod>>>)[method];
}

// ── Merging two brains' answers: the Mac's router and the phone's Home both call these ──

/** One host's answer to a list, with how far it could be reached. */
export interface HostPage {
  brain: Brain;
  reach: OwnerReach;
  heardAt: number;
  rows: readonly ThreadSummary[];
}

type ListOrder = { filter?: ThreadFilter | undefined; orderBy?: "activity" | undefined };
type Sorted = Pick<ThreadSummary, "id" | "pinnedAt" | "lastActivityAt" | "archivedAt" | "doneAt">;

const later = (a: number | null, b: number | null) => (b ?? -Infinity) - (a ?? -Infinity);
const higherId = (a: Sorted, b: Sorted) => Number(a.id < b.id) - Number(a.id > b.id);

/** The JS twin of db's threadListOrder; ties, which SQL leaves open, fall to the higher id. */
export function threadListCompare({ filter, orderBy }: ListOrder = {}): (a: Sorted, b: Sorted) => number {
  if (orderBy === "activity") return (a, b) => later(a.lastActivityAt, b.lastActivityAt) || higherId(a, b);
  if (filter === "archived") return (a, b) => later(a.archivedAt, b.archivedAt) || higherId(a, b);
  if (filter === "done") return (a, b) => later(a.doneAt, b.doneAt) || higherId(a, b);
  return (a, b) => Number(b.pinnedAt !== null) - Number(a.pinnedAt !== null) || later(a.lastActivityAt, b.lastActivityAt) || higherId(a, b);
}

interface Held {
  row: ThreadSummary;
  page: HostPage;
}

/**
 * One page of a list from several hosts' pages of it. Each host answered with its own top `limit` (with each parent's
 * tree when asked), so the merged top `limit` is exact. A thread two hosts list, as in a relocation's gap, appears once:
 * the copy that is not moving wins. Rows from a host other than `self` carry `owner`.
 */
export function mergeThreadPages(
  pages: readonly HostPage[],
  list: ListOrder & { limit?: number | undefined; includeChildren?: boolean | undefined; selectedId?: string | undefined },
  self: Brain | null,
): ThreadSummary[] {
  const held = new Map<string, Held>();
  for (const page of pages)
    for (const row of page.rows) {
      const kept = held.get(row.id);
      if (!kept || (kept.row.moving && !row.moving)) held.set(row.id, { row, page });
    }
  const parentOf = (entry: Held): Held | null => {
    const parent = list.includeChildren && entry.row.parentThreadId ? held.get(entry.row.parentThreadId) : undefined;
    return parent?.page === entry.page ? parent : null;
  };
  const rootOf = (entry: Held): Held => {
    let root = entry;
    for (let parent = parentOf(root); parent && parent !== entry; parent = parentOf(root)) root = parent;
    return root;
  };
  const trees = new Map<Held, Held[]>();
  for (const entry of held.values()) {
    const root = rootOf(entry);
    trees.set(root, [...(trees.get(root) ?? []), entry]);
  }
  const compare = threadListCompare(list);
  const treeActivity = (tree: Held[]) => Math.max(...tree.map((entry) => entry.row.treeActivityAt ?? entry.row.lastActivityAt));
  const roots = [...trees.entries()]
    .map(([root, tree]) => ({ root, tree, sorted: { ...root.row, lastActivityAt: list.includeChildren ? treeActivity(tree) : root.row.lastActivityAt } }))
    .sort((a, b) => compare(a.sorted, b.sorted));
  const kept = roots.filter((entry, index) => !list.limit || index < list.limit || entry.tree.some((each) => each.row.id === list.selectedId));
  const stamp = ({ row, page }: Held): ThreadSummary => (page.brain === self ? row : { ...row, owner: { brain: page.brain, reach: page.reach, heardAt: page.heardAt } });
  return kept
    .flatMap((entry) => entry.tree)
    .sort((a, b) => compare(a.row, b.row))
    .map(stamp);
}

/** Tasks from every host, each once (the first host's copy wins, as in a move's gap), the latest change first. */
export function mergeTaskPages(pages: readonly { brain: Brain; reach: OwnerReach; heardAt: number; rows: readonly Task[] }[], self: Brain): Task[] {
  const held = new Map<string, Task>();
  for (const { brain, reach, heardAt, rows } of pages) for (const row of rows) if (!held.has(row.id)) held.set(row.id, brain === self ? row : { ...row, owner: { brain, reach, heardAt } });
  return [...held.values()].sort((a, b) => b.updatedAt - a.updatedAt || Number(a.id < b.id) - Number(a.id > b.id));
}

const inboxKey = (item: InboxItem) => `${item.kind}:${item.kind === "task" ? item.task.id : item.thread.id}:${item.runId ?? ""}:${item.reason}`;

/** Needs-you items from every host, each once, in the hosts' order. */
export function mergeInbox(pages: readonly { inbox: InboxList }[]): InboxList {
  const seen = new Set<string>();
  const items: InboxItem[] = [];
  for (const { inbox } of pages)
    for (const item of inbox.items) {
      const key = inboxKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  return { items };
}
