import { QueryClient, useMutation, useQuery, type Query, type UseQueryOptions } from "@tanstack/react-query";
import type { RpcMethod, RpcParams, RpcResults } from "@openorc/protocol";
import { core } from "./rpc";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * Cache tags per query, matched against the core's invalidation keys and the
 * tags each mutation touches. Every read has at least one tag so no screen
 * can go stale after a write.
 */
export function tagsFor(method: RpcMethod, params: unknown): string[] {
  const p = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case "workspace.get":
      return ["workspace"];
    case "slack.status":
      return ["slack"];
    case "system.info":
      return ["system"];
    case "agents.updates.get":
      return ["agent-updates"];
    case "providers.usage":
      return ["provider-usage", "system", "settings"];
    case "agents.models":
    case "agents.modelCatalog":
      return ["models"];
    case "skills.list":
      // Project scoped: importing or removing a project changes what the
      // composer can offer, and a skill added on disk is found by a refetch.
      return ["skills", `project:${String(p["projectId"] ?? "")}`];
    case "memory.settings.get":
    case "app.settings.get":
      return ["settings"];
    case "textGeneration.settings.get":
      return ["text-generation", "system", "models"];
    case "schedules.list":
      return ["schedules", "orchestration"];
    case "orchestration.list":
    case "orchestration.preflight":
      return ["orchestration", `orchestration:${String(p["projectId"])}`];
    case "orchestration.get":
      return ["orchestration", `team:${String(p["id"])}`];
    case "orchestration.avatars.list":
      return ["orchestration.avatars", `team:${String(p["teamId"])}`];
    case "orchestration.availability":
      return ["settings", "orchestration"];
    case "orchestration.turnChanges":
      return [`checkpoints:${String(p["threadId"])}`];
    case "orchestration.runtime":
      return ["orchestration", "inbox", `thread:${String(p["threadId"])}`];
    case "tasks.executionThread":
      return ["tasks", "threads", `task:${String(p["taskId"])}`];
    case "tasks.forwarding":
      return ["settings", "tasks", "orchestration", "inbox", "threads", `task:${String(p["taskId"])}`];
    case "orchestration.taskState":
      return ["orchestration", "inbox", "threads", `task:${String(p["taskId"])}`, `comments:${String(p["taskId"])}`];
    case "orchestration.taskRuntime":
      return ["orchestration", "inbox", "tasks", `task:${String(p["taskId"])}`];
    case "projects.list":
      return ["projects"];
    case "projects.get":
      return ["projects", `project:${String(p["id"])}`];
    case "tasks.list":
      return ["tasks", ...(p["threadId"] ? [`thread:${String(p["threadId"])}`] : [])];
    case "threads.list":
      return ["threads"];
    case "threads.plans":
      return [`plans:${String(p["id"])}`];
    case "threads.get":
    case "threads.messages":
      return ["threads", `thread:${String(p["id"])}`];
    case "threads.search":
      return ["threads", "messages"];
    case "threads.checkpoints":
      return [`checkpoints:${String(p["id"])}`];
    case "threads.importable":
      return ["threads", `importable:${String(p["projectId"])}`];
    case "runs.listForThread":
      return [`runs:thread:${String(p["threadId"])}`];
    case "review.threadDiff":
      return ["workspace-diff", `threaddiff:${String(p["threadId"])}`, `thread:${String(p["threadId"])}`];
    case "git.threadLog":
    case "git.threadPushState":
      return [`threadlog:${String(p["threadId"])}`, `thread:${String(p["threadId"])}`];
    case "files.search":
      return ["files"];
    case "tasks.get":
      return ["tasks", `task:${String(p["id"])}`];
    case "runs.listForTask":
      return [`runs:${String(p["taskId"])}`];
    case "review.checkoutState":
      return [`checkout:${String(p["taskId"])}`, "tasks", "threads", `runs:${String(p["taskId"])}`];
    case "review.diff":
      return [`diff:${String(p["taskId"])}`];
    case "review.projectDiff":
      return ["workspace-diff", `projectdiff:${String(p["projectId"])}`, "threads"];
    case "review.snapshots":
      return [`snapshots:${String(p["taskId"])}`];
    case "git.log":
      return [`log:${String(p["taskId"])}`];
    case "inbox.list":
      return ["inbox", "tasks"];
    case "tasks.comments.list":
      return [`task-comments:${String(p["taskId"])}`];
    case "review.comments.list":
      return reviewCommentTags(p);
    case "workspace.usage":
      return [`task:${String(p["taskId"])}`];
    case "memory.list":
    case "memory.search":
      return ["memory", `memory:${String(p["projectId"])}`];
    case "memory.forTask":
      return ["memory", `memory:task:${String(p["taskId"])}`];
    default:
      return [];
  }
}

/** A conversation's review comments and a task's are tagged apart; a task screen reads both. */
function reviewCommentTags(p: Record<string, unknown>): string[] {
  return [...(p["threadId"] ? [`comments:thread:${String(p["threadId"])}`] : []), ...(p["taskId"] ? [`comments:${String(p["taskId"])}`] : [])];
}

/**
 * What each mutation changes, so the renderer refreshes its own reads the
 * moment the call returns instead of waiting on a push from the core.
 */
const workspaceMutations = new Set<RpcMethod>(["threads.moveWorkspace", "threads.cancelMove", "threads.cancelTeamOperation", "threads.restore"]);

function workspaceMutationTags(id: string): string[] {
  return ["workspace-diff", "threads", "tasks", "inbox", "orchestration", `thread:${id}`, `threaddiff:${id}`, `threadlog:${id}`, `checkpoints:${id}`];
}

export function invalidatesFor(method: RpcMethod, params: unknown): string[] {
  if (method.startsWith("agents.updates.")) return ["agent-updates", ...(method === "agents.updates.install" ? ["system", "models"] : [])];
  if (method === "providers.codex.reset") return ["provider-usage"];
  if (method === "agents.models.refresh") return ["models"];
  if (method === "workspace.configure") return ["workspace", "projects"];
  if (method.startsWith("projects.")) return ["projects", "tasks"];
  const p = (params ?? {}) as Record<string, unknown>;
  if (method.startsWith("tasks.comments.")) return [`task-comments:${String(p["taskId"])}`];
  if (workspaceMutations.has(method)) return workspaceMutationTags(String(p["id"]));
  const task = `task:${String(p["taskId"] ?? p["id"])}`;
  // A retained owner is controlled through a surviving task; its runtime is read under that task.
  const scopedTask = p["taskId"] ? [`task:${String(p["taskId"])}`] : [];
  switch (method) {
    case "orchestration.save":
    case "orchestration.archive":
      return ["orchestration", `orchestration:${String(p["projectId"])}`, ...(p["teamId"] ? [`team:${String(p["teamId"])}`] : [])];
    case "orchestration.avatars.set":
    case "orchestration.avatars.reset":
      return ["orchestration.avatars", `team:${String(p["teamId"])}`];
    case "orchestration.stop":
    case "orchestration.retry":
    case "orchestration.workspace.retrySetup":
    case "orchestration.workspace.acceptSetup":
    case "orchestration.compact":
    case "orchestration.cancelDirection":
    case "orchestration.send":
    case "orchestration.implementPlan":
    case "orchestration.configureLead":
      return ["orchestration", "threads", "tasks", `thread:${String(p["threadId"])}`, `runs:thread:${String(p["threadId"])}`, ...scopedTask];
    case "orchestration.integration.retry":
    case "orchestration.integration.accept":
      return ["workspace-diff", "orchestration", "threads", "tasks", `thread:${String(p["threadId"])}`, `runs:thread:${String(p["threadId"])}`, ...scopedTask];
    case "tasks.forward":
      return ["workspace-diff", "orchestration", "threads", "tasks", "inbox", task, `comments:${String(p["taskId"])}`, `runs:${String(p["taskId"])}`, `diff:${String(p["taskId"])}`];
    case "orchestration.tasks.start":
    case "orchestration.tasks.retry":
    case "orchestration.review.send":
      return ["orchestration", "threads", "tasks", "inbox", task, `comments:${String(p["taskId"])}`, `runs:${String(p["taskId"])}`, `diff:${String(p["taskId"])}`];
    case "tasks.create":
    case "tasks.update":
    case "tasks.delete":
    case "tasks.prepareWorkspace":
    case "tasks.start":
    case "tasks.openThread":
      return ["tasks", "inbox", "threads", task];
    case "threads.delete":
      return ["threads", "tasks", "inbox", "orchestration", `thread:${String(p["id"])}`, `importable:${String(p["projectId"])}`];
    case "threads.start":
    case "threads.fork":
    case "threads.import":
      return ["threads", "tasks", "inbox", `thread:${String(p["id"])}`, `importable:${String(p["projectId"])}`];
    case "threads.update":
      return ["threads", "tasks", "inbox", `thread:${String(p["id"])}`, `runs:thread:${String(p["id"])}`, `importable:${String(p["projectId"])}`, ...scopedTask];
    case "threads.implementPlan":
    case "threads.compact":
    case "threads.queue":
    case "threads.send":
      return ["threads", `thread:${String(p["id"])}`, `runs:thread:${String(p["id"])}`];
    // Removing a queued review message returns its comments to the review.
    case "threads.unqueue":
      return ["threads", `thread:${String(p["id"])}`, `runs:thread:${String(p["id"])}`, `comments:thread:${String(p["id"])}`];
    case "review.commitThread":
      return ["workspace-diff", `threaddiff:${String(p["threadId"])}`, `threadlog:${String(p["threadId"])}`, `thread:${String(p["threadId"])}`, "threads", "orchestration"];
    case "review.pushThread":
    case "review.createThreadPr":
      return ["threads", `thread:${String(p["threadId"])}`, `threaddiff:${String(p["threadId"])}`, `threadlog:${String(p["threadId"])}`];
    case "app.settings.set":
      return ["settings"];
    case "schedules.create":
    case "schedules.update":
    case "schedules.delete":
    case "schedules.run":
    case "schedules.trigger":
      return ["schedules", "threads"];
    case "runs.start":
    case "runs.send":
    case "runs.close":
      return ["tasks", "inbox", "threads", task, `runs:${String(p["taskId"])}`, `thread:${String(p["threadId"])}`, `runs:thread:${String(p["threadId"])}`];
    case "workspace.cleanup":
    case "review.markReviewed":
      return ["tasks", task, `diff:${String(p["taskId"])}`];
    case "review.comments.add":
    case "review.comments.remove":
      return reviewCommentTags(p);
    // The comments leave as a queued message in the conversation, and reopen the task they were written from.
    case "review.comments.send":
      return [...reviewCommentTags(p), "threads", `thread:${String(p["threadId"])}`, ...(p["taskId"] ? ["tasks", task] : [])];
    case "review.commitProject":
      return ["workspace-diff", `projectdiff:${String(p["projectId"])}`];
    case "review.commit":
      return ["workspace-diff", `diff:${String(p["taskId"])}`, `log:${String(p["taskId"])}`, `snapshots:${String(p["taskId"])}`, task, "tasks"];
    case "review.push":
    case "review.createPr":
      return [`diff:${String(p["taskId"])}`, `log:${String(p["taskId"])}`, `snapshots:${String(p["taskId"])}`, task, "tasks"];
    case "memory.record":
    case "memory.update":
    case "memory.feedback":
    case "memory.remove":
    case "memory.promote":
      return ["memory"];
    case "memory.settings.set":
      return ["settings"];
    case "textGeneration.settings.set":
      return ["text-generation"];
    default:
      return [];
  }
}

const pendingTags = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flushInvalidations(cancelRefetch = true): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingTags.size === 0) return;
  const batch = new Set(pendingTags);
  pendingTags.clear();
  const predicate = (q: Query) => ((q.meta?.["tags"] as string[] | undefined) ?? []).some((t) => batch.has(t));
  // Without cancelling, a read already loading absorbs this refresh, yet it may predate the change announced: read it once more after.
  const loading = cancelRefetch ? [] : queryClient.getQueryCache().findAll({ predicate, fetchStatus: "fetching" });
  void queryClient.invalidateQueries({ predicate }, { cancelRefetch }).then(() => {
    for (const query of loading) void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true }, { cancelRefetch: false });
  });
}

/**
 * Every provider event invalidates the same few tags; one refetch pass per short
 * window is all the screen can use. The user's own actions refresh at once.
 */
export function invalidateTags(keys: string[], options: { immediate?: boolean } = {}): void {
  if (keys.length === 0) return;
  for (const key of keys) pendingTags.add(key);
  if (options.immediate) {
    flushInvalidations();
    return;
  }
  // Pushed while agents work, sometimes every second: a slow read still loading, such as a large diff, finishes instead of restarting.
  if (!flushTimer) flushTimer = setTimeout(() => flushInvalidations(false), 50);
}

core.onInvalidate(invalidateTags);
// A core that (re)started probes the machine afresh; what the renderer remembered about CLIs and models is stale.
core.onReady(() => invalidateTags(["system", "models", "agent-updates"]));

export function useRpc<M extends RpcMethod>(method: M, params: RpcParams<M>, options: Partial<Pick<UseQueryOptions<RpcResults[M]>, "enabled" | "staleTime" | "refetchInterval">> = {}) {
  return useQuery<RpcResults[M]>({
    queryKey: [method, params],
    queryFn: () => core.call(method, params),
    meta: { tags: tagsFor(method, params) },
    ...options,
  });
}

export function useRpcMutation<M extends RpcMethod>(method: M) {
  return useMutation<RpcResults[M], Error, RpcParams<M>>({
    mutationFn: (params) => core.call(method, params),
    onSuccess: (_result, params) => invalidateTags(invalidatesFor(method, params), { immediate: true }),
  });
}
