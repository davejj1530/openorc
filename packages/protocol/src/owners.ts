import type { ThreadFilter, ThreadSummary } from "./domain.js";
import type { RpcMethod, RpcParams } from "./rpc.js";
import type { Brain, OwnerReach } from "./thread-owner.js";

/**
 * Every method whose params name a thread (`threadId`, or `id` on a threads.* method), a run (`runId`) or a task
 * (`taskId`, or `id` on a tasks.* method). Derived from the schemas, so a new such method does not compile until
 * OWNER_ROUTES says how it routes.
 */
type NamesThreadOrRun<M extends RpcMethod, P = RpcParams<M>> = M extends `tasks.online.${string}`
  ? never
  : string extends keyof P
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
  /** Every place answers its own rows; the asker merges them, never waiting on one. Asked about one thread, its owner answers. */
  | { by: "merge"; thread?: (params: RpcParams<M>) => string | undefined }
  /** The host holding the task answers: tasks move with the thread doing their work. */
  | { by: "task"; task: (params: RpcParams<M>) => string | undefined }
  /** Served by the asked host even for another place's thread: its folder, its preview, its windows. */
  | { by: "here" }
  /** A new thread starts on the asked host; the place router sends one asked for OpenOrc Cloud there itself. */
  | { by: "start" };

const byThreadId = { by: "owner", thread: (p: { threadId?: string | undefined }) => p.threadId } as const;
const byId = { by: "owner", thread: (p: { id: string }) => p.id } as const;
const byRun = { by: "run", run: (p: { runId: string }) => p.runId } as const;
const byTask = { by: "task", task: (p: { taskId: string }) => p.taskId } as const;
const byTaskId = { by: "task", task: (p: { id: string }) => p.id } as const;
const here = { by: "here" } as const;

/**
 * How a Mac window's call reaches a thread's owner. The Mac's place router reads it. Methods not listed and not
 * RoutedMethod are host-level: the asked core answers about itself.
 */
export const OWNER_ROUTES: { [M in RoutedMethod]: OwnerRoute<M> } & { [M in Exclude<RpcMethod, RoutedMethod>]?: OwnerRoute<M> } = {
  "tasks.online.state": here,
  "tasks.online.openThread": here,
  "tasks.online.openHere": here,
  "tasks.online.list": here,
  "tasks.online.get": here,
  "tasks.online.create": here,
  "tasks.online.update": here,
  "tasks.online.delete": here,
  "tasks.online.seen": here,
  "tasks.online.attention": here,
  "tasks.online.assignees": here,
  "tasks.online.activity": here,
  "tasks.online.context": here,
  "tasks.online.board": here,
  "tasks.online.saveBoard": here,
  "tasks.online.boards": here,
  "tasks.online.reports": here,
  "tasks.online.answerReport": here,
  "hosted.review.changes": byThreadId,
  "hosted.capabilities": byThreadId,
  "hosted.review.turn": byThreadId,
  "hosted.review.file": byThreadId,
  "hosted.review.state": byThreadId,
  "hosted.review.commits": byThreadId,
  "hosted.review.commit": byThreadId,
  "hosted.review.action": byThreadId,
  "hosted.terminal.list": byThreadId,
  "hosted.terminal.open": byThreadId,
  "hosted.terminal.output": byThreadId,
  "hosted.terminal.input": byThreadId,
  "hosted.terminal.size": byThreadId,
  "hosted.terminal.end": byThreadId,
  "hosted.terminal.watch": byThreadId,
  "threads.collaboration": byThreadId,
  "threads.authors": byThreadId,
  "threads.people": byThreadId,
  "threads.startQueued": byThreadId,
  "threads.retrySave": byThreadId,
  "threads.stopWork": byThreadId,
  "threads.notes": byThreadId,
  "threads.postNote": byThreadId,
  "threads.readNotes": byThreadId,
  "threads.start": { by: "start" },
  "threads.list": { by: "merge" },
  "threads.resolvedCount": { by: "merge" },
  "threads.search": { by: "merge" },
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
  "threads.ready": byId,
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
  "tasks.refine.get": byTask,
  "tasks.refine.start": byTask,
  "tasks.refine.stop": byTask,
  "tasks.refine.dismiss": byTask,
  "tasks.threads": byTask,
  "tasks.events": byTask,
  "tasks.answerUpdate": byTask,
  // A project's automations are kept and run by the core that holds its folder, also one kept to a task.
  "automations.save": here,
  "tasks.newThread": byTask,
  "tasks.runButton": byTask,
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
  "review.threadCommitChanges": byThreadId,
  "review.threadCommitFileDiff": byThreadId,
  "review.threadDiff": byThreadId,
  "review.commitThread": byThreadId,
  "review.pushThread": byThreadId,
  "review.createThreadPr": byThreadId,
  "review.threadPrTemplate": byThreadId,
  "git.threadLog": byThreadId,
  "git.commitRange": byThreadId,
  "git.threadCommit": byThreadId,
  "review.threadCommitDiff": byThreadId,
  "git.threadPushState": byThreadId,
  "review.comments.list": byThreadId,
  "review.comments.add": byThreadId,
  "review.comments.remove": byThreadId,
  "review.comments.send": byThreadId,
  "threads.moveWorkspace": byId,
  "threads.movePreview": byId,
  "threads.fork": byId,
  "threads.restore": byId,
  "threads.restorePreview": byId,
  "orclings.ask": byThreadId,
  "orclings.assign": byThreadId,
  "orclings.reactions": byThreadId,
  "orclings.react": byThreadId,
  "orclings.origins": byThreadId,
  "orclings.groups.send": byThreadId,
  "orclings.groups.delete": byThreadId,
  // The Mac's own: its instructions, its preview and its app views.
  "instructions.list": here,
  "instructions.save": here,
  "preview.state": here,
  "mcpApps.open": here,
  "mcpApps.read": here,
  "mcpApps.call": here,
  "mcpApps.close": here,
  // A cloud thread's work brought into this Mac's own folder: only this Mac has it.
  "macProjects.bringState": here,
  "macProjects.bring": here,
  "threads.moveCheck": here,
  "threads.move": here,
  "threads.moveDismiss": here,
  "threads.cloudCopy": here,
  "threads.cloudCopyRefresh": here,
};

export function ownerRoute(method: RpcMethod): OwnerRoute<RpcMethod> | undefined {
  return (OWNER_ROUTES as Partial<Record<RpcMethod, OwnerRoute<RpcMethod>>>)[method];
}

// ── Merging two places' answers: the Mac's place router calls this ──

/** One place's answer to a list, with whether it could be reached. */
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
 * One page of a list from several places' pages of it. Each place answered with its own top `limit` (with each parent's
 * tree when asked), so the merged top `limit` is exact. A thread two places list appears once: the first one's. Rows
 * from a place other than `self` carry `owner`.
 */
export function mergeThreadPages(
  pages: readonly HostPage[],
  list: ListOrder & { limit?: number | undefined; includeChildren?: boolean | undefined; selectedId?: string | undefined },
  self: Brain | null,
): ThreadSummary[] {
  const held = new Map<string, Held>();
  for (const page of pages)
    for (const row of page.rows) {
      if (!held.has(row.id)) held.set(row.id, { row, page });
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
  // What a place stamped on its own rows about them (an OpenOrc Cloud thread's project) stays; who answered is the page's.
  const stamp = ({ row, page }: Held): ThreadSummary => (page.brain === self ? row : { ...row, owner: { ...row.owner, brain: page.brain, reach: page.reach, heardAt: page.heardAt } });
  return kept
    .flatMap((entry) => entry.tree)
    .sort((a, b) => compare(a.row, b.row))
    .map(stamp);
}
