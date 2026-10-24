import type { FileReadMethod, FileScope, RpcMethod, RpcParams } from "@openorc/protocol";

type Rule<M extends RpcMethod> = (params: RpcParams<M>) => string[];
type Rules = { [M in RpcMethod]?: Rule<M> };

/** The diff key RunLive pushes when an agent writes in this scope's folder. A chosen Workspace folder has none. */
function folderTags(scope: FileScope): string[] {
  if (scope.kind === "project") return scope.workingDirectory ? [] : [`projectdiff:${scope.id}`];
  return [scope.kind === "thread" ? `threaddiff:${scope.id}` : `diff:${scope.id}`];
}

function reviewCommentTags({ threadId, taskId }: { threadId?: string | undefined; taskId?: string | undefined }): string[] {
  return [...(threadId ? [`comments:thread:${threadId}`] : []), ...(taskId ? [`comments:${taskId}`] : [])];
}

const fileReadRules: { [M in FileReadMethod]: Rule<M> } = {
  "files.list": ({ scope }) => ["files", "workspace-diff", ...folderTags(scope)],
  "files.read": ({ scope }) => ["workspace-diff", ...folderTags(scope)],
  "files.search": () => ["files"],
  // Saves, commits, terminal commands and window focus rerun a find; an agent's edits wait until the results show again.
  "files.find": () => ["files", "workspace-diff"],
};

const readRules: Rules = {
  ...fileReadRules,
  "instructions.list": ({ threadId }) => ["instructions", "workspace-diff", `thread:${threadId}`],
  "review.comments.list": reviewCommentTags,
};

const mutationRules: Rules = {
  "review.comments.add": reviewCommentTags,
  "review.comments.remove": reviewCommentTags,
  "review.comments.send": ({ threadId, taskId }) => [...reviewCommentTags({ threadId, taskId }), "threads", `thread:${threadId}`, ...(taskId ? ["tasks", `task:${taskId}`] : [])],
};

type Params = Record<string, unknown>;
type MethodRules = Partial<Record<RpcMethod, (p: Params) => string[]>>;

/** One rule for several methods. */
function each(methods: RpcMethod[], rule: (p: Params) => string[]): MethodRules {
  return Object.fromEntries(methods.map((method) => [method, rule]));
}

/** The task a write names, by its own id or the task it belongs to. */
function taskTag(p: Params): string {
  return `task:${String(p["taskId"] ?? p["id"])}`;
}

/** A retained owner is controlled through a surviving task; its runtime is read under that task. */
function scopedTask(p: Params): string[] {
  return p["taskId"] ? [`task:${String(p["taskId"])}`] : [];
}

/** Reads whose tags never depend on their parameters. */
const fixedTags: Partial<Record<RpcMethod, readonly string[]>> = {
  "claude.accounts.list": ["claude-accounts"],
  "workspace.get": ["workspace"],
  "slack.status": ["slack"],
  "remote.status": ["remote"],
  "system.info": ["system"],
  "agents.availability": ["system", "claude-accounts"],
  "agents.updates.get": ["agent-updates"],
  "providers.usage": ["provider-usage", "system", "settings"],
  // Not "settings": a palette changed on the Mac must not start its CLIs again for a phone.
  "providers.limits": ["provider-usage", "claude-accounts", "system"],
  "agents.models": ["models"],
  "agents.modelCatalog": ["models"],
  "memory.settings.get": ["settings"],
  "app.settings.get": ["settings"],
  "textGeneration.settings.get": ["text-generation", "system", "models"],
  "schedules.list": ["schedules", "orchestration"],
  "orchestration.availability": ["settings", "orchestration"],
  "projects.list": ["projects"],
  "projects.checkoutBranch": ["projects", "workspace-diff"],
  "threads.list": ["threads"],
  "threads.search": ["threads", "messages"],
  "inbox.list": ["inbox", "tasks"],
  // GitHub's side of a pull request, and the draft review kept here.
  "pulls.list": ["pulls"],
  "pulls.branches": ["pulls"],
  "pulls.get": ["pulls"],
  "pulls.diff": ["pulls"],
  "pulls.review.get": ["pull-reviews"],
  "reviewerApp.get": ["reviewer-app"],
  // Orclings, their instructions and what they remember.
  "orclings.list": ["orclings"],
  "orclings.instructions": ["orclings"],
  "orclings.memories": ["orclings", "memory"],
};

/** Reads tagged by the ids in their parameters. */
const idReadTags: MethodRules = {
  "skills.list": (p) => ["skills", `project:${String(p["projectId"] ?? "")}`],
  ...each(["orchestration.list", "orchestration.preflight"], (p) => ["orchestration", `orchestration:${String(p["projectId"])}`]),
  "orchestration.get": (p) => ["orchestration", `team:${String(p["id"])}`],
  "orchestration.avatars.list": (p) => ["orchestration.avatars", `team:${String(p["teamId"])}`],
  "orchestration.turnChanges": (p) => [`checkpoints:${String(p["threadId"])}`],
  "orchestration.runtime": (p) => ["orchestration", "inbox", `thread:${String(p["threadId"])}`],
  "tasks.executionThread": (p) => ["tasks", "threads", `task:${String(p["taskId"])}`],
  "tasks.forwarding": (p) => ["settings", "tasks", "orchestration", "inbox", "threads", `task:${String(p["taskId"])}`],
  "orchestration.taskState": (p) => ["orchestration", "inbox", "threads", `task:${String(p["taskId"])}`, `comments:${String(p["taskId"])}`],
  "orchestration.taskRuntime": (p) => ["orchestration", "inbox", "tasks", `task:${String(p["taskId"])}`],
  "projects.get": (p) => ["projects", `project:${String(p["id"])}`],
  // Git can appear in a turn, a commit, the terminal or outside the app; focus and settled commands refresh workspace-diff.
  "projects.git": (p) => ["projects", "workspace-diff", `projectgit:${String(p["id"])}`],
  "tasks.list": (p) => ["tasks", ...(p["threadId"] ? [`thread:${String(p["threadId"])}`] : [])],
  "threads.plans": (p) => [`plans:${String(p["id"])}`],
  ...each(["threads.get", "threads.messages"], (p) => ["threads", `thread:${String(p["id"])}`]),
  // Only the conversation's own sends and turns change what was said last, so other threads' activity leaves it be.
  "threads.lastMessage": (p) => [`thread:${String(p["id"])}`],
  "threads.checkpoints": (p) => [`checkpoints:${String(p["id"])}`],
  "threads.importable": (p) => ["threads", `importable:${String(p["projectId"])}`],
  "runs.listForThread": (p) => [`runs:thread:${String(p["threadId"])}`],
  "review.threadDiff": (p) => ["workspace-diff", `threaddiff:${String(p["threadId"])}`, `thread:${String(p["threadId"])}`],
  // A checkout's branch moves with commits and pushes made anywhere, so these refresh with workspace-diff too.
  ...each(["git.threadLog", "git.threadPushState"], (p) => ["workspace-diff", `threadlog:${String(p["threadId"])}`, `thread:${String(p["threadId"])}`]),
  ...each(["git.projectLog", "git.projectPushState"], (p) => ["workspace-diff", `projectlog:${String(p["projectId"])}`]),
  "tasks.get": (p) => ["tasks", `task:${String(p["id"])}`],
  "runs.listForTask": (p) => [`runs:${String(p["taskId"])}`],
  "review.checkoutState": (p) => [`checkout:${String(p["taskId"])}`, "tasks", "threads", `runs:${String(p["taskId"])}`],
  "review.diff": (p) => [`diff:${String(p["taskId"])}`],
  "review.projectDiff": (p) => ["workspace-diff", `projectdiff:${String(p["projectId"])}`, "threads"],
  "review.snapshots": (p) => [`snapshots:${String(p["taskId"])}`],
  "git.log": (p) => [`log:${String(p["taskId"])}`],
  "tasks.comments.list": (p) => [`task-comments:${String(p["taskId"])}`],
  "workspace.usage": (p) => [`task:${String(p["taskId"])}`],
  ...each(["memory.list", "memory.search"], (p) => ["memory", `memory:${String(p["projectId"])}`]),
  "memory.forTask": (p) => ["memory", `memory:task:${String(p["taskId"])}`],
};

/**
 * Cache tags per query, matched against the core's invalidation keys and the
 * tags each mutation touches. Every read has at least one tag so no screen
 * can go stale after a write.
 */
export function tagsFor<M extends RpcMethod>(method: M, params: RpcParams<M>): string[] {
  const fixed = fixedTags[method];
  if (fixed) return [...fixed];
  const rule = readRules[method];
  if (rule) return rule(params);
  return idReadTags[method]?.((params ?? {}) as Params) ?? [];
}

/**
 * What each mutation changes, so the renderer refreshes its own reads the
 * moment the call returns instead of waiting on a push from the core.
 */
const workspaceMutations = new Set<RpcMethod>(["threads.moveWorkspace", "threads.cancelMove", "threads.cancelTeamOperation", "threads.restore"]);

/** Mutations whose effects never depend on their parameters. */
const fixedInvalidations: Partial<Record<RpcMethod, readonly string[]>> = {
  "claude.accounts.list": ["claude-accounts", "system", "models", "provider-usage"],
  "claude.accounts.add": ["claude-accounts"],
  "claude.accounts.update": ["claude-accounts", "system", "models", "provider-usage"],
  "claude.accounts.login": ["claude-accounts"],
  "claude.accounts.cancelLogin": ["claude-accounts"],
  "providers.codex.reset": ["provider-usage"],
  "agents.models.refresh": ["models"],
  "workspace.configure": ["workspace", "projects"],
  "app.settings.set": ["settings"],
  "memory.settings.set": ["settings"],
  "textGeneration.settings.set": ["text-generation"],
  "memory.record": ["memory"],
  "memory.update": ["memory"],
  "memory.feedback": ["memory"],
  "memory.remove": ["memory"],
  "memory.promote": ["memory"],
  // A project's file shows in its conversation's changes too.
  "instructions.save": ["instructions", "workspace-diff"],
  "pulls.review.comment": ["pull-reviews"],
  "pulls.review.editComment": ["pull-reviews"],
  "pulls.review.removeComment": ["pull-reviews"],
  "pulls.review.summary": ["pull-reviews"],
  "pulls.review.discard": ["pull-reviews"],
  "pulls.review.start": ["pull-reviews", "threads"],
  // A posted review can change the pull request's review decision.
  "pulls.review.submit": ["pull-reviews", "pulls"],
  "reviewerApp.setup": ["reviewer-app"],
  "reviewerApp.cancelSetup": ["reviewer-app"],
  "reviewerApp.configure": ["reviewer-app"],
  "reviewerApp.remove": ["reviewer-app"],
  "orclings.create": ["orclings", "threads"],
  // Team seats read their Orcling's current model, so teams refresh with it.
  "orclings.update": ["orclings", "threads", "orchestration"],
  "orclings.delete": ["orclings", "threads", "memory", "orchestration"],
  "orclings.instructions.save": ["orclings"],
  "orclings.instructions.restore": ["orclings"],
  "orclings.ask": ["threads"],
  "orclings.assign": ["orclings", "threads"],
  "remote.configure": ["remote"],
  "remote.pairing.begin": ["remote"],
  "remote.pairing.cancel": ["remote"],
  "remote.devices.remove": ["remote"],
};

function workspaceMutationTags(id: string): string[] {
  return ["workspace-diff", "threads", "tasks", "inbox", "orchestration", `thread:${id}`, `threaddiff:${id}`, `threadlog:${id}`, `checkpoints:${id}`];
}

/** Writes whose effects follow the ids in their parameters. */
const idInvalidations: MethodRules = {
  ...each(["orchestration.save", "orchestration.archive"], (p) => ["orchestration", `orchestration:${String(p["projectId"])}`, ...(p["teamId"] ? [`team:${String(p["teamId"])}`] : [])]),
  ...each(["orchestration.avatars.set", "orchestration.avatars.reset"], (p) => ["orchestration.avatars", `team:${String(p["teamId"])}`]),
  ...each(
    [
      "orchestration.stop",
      "orchestration.retry",
      "orchestration.workspace.retrySetup",
      "orchestration.workspace.acceptSetup",
      "orchestration.compact",
      "orchestration.cancelDirection",
      "orchestration.send",
      "orchestration.implementPlan",
      "orchestration.configureLead",
    ],
    (p) => ["orchestration", "threads", "tasks", `thread:${String(p["threadId"])}`, `runs:thread:${String(p["threadId"])}`, ...scopedTask(p)],
  ),
  ...each(["orchestration.integration.retry", "orchestration.integration.accept"], (p) => [
    "workspace-diff",
    "orchestration",
    "threads",
    "tasks",
    `thread:${String(p["threadId"])}`,
    `runs:thread:${String(p["threadId"])}`,
    ...scopedTask(p),
  ]),
  "tasks.forward": (p) => ["workspace-diff", "orchestration", "threads", "tasks", "inbox", taskTag(p), `comments:${String(p["taskId"])}`, `runs:${String(p["taskId"])}`, `diff:${String(p["taskId"])}`],
  ...each(["orchestration.tasks.start", "orchestration.tasks.retry", "orchestration.review.send"], (p) => [
    "orchestration",
    "threads",
    "tasks",
    "inbox",
    taskTag(p),
    `comments:${String(p["taskId"])}`,
    `runs:${String(p["taskId"])}`,
    `diff:${String(p["taskId"])}`,
  ]),
  ...each(["tasks.create", "tasks.update", "tasks.delete", "tasks.prepareWorkspace", "tasks.start", "tasks.openThread"], (p) => ["tasks", "inbox", "threads", taskTag(p)]),
  "threads.delete": (p) => ["threads", "tasks", "inbox", "orchestration", `thread:${String(p["id"])}`, `importable:${String(p["projectId"])}`],
  ...each(["threads.start", "threads.fork", "threads.import"], (p) => ["threads", "tasks", "inbox", `thread:${String(p["id"])}`, `importable:${String(p["projectId"])}`]),
  "threads.update": (p) => ["threads", "tasks", "inbox", `thread:${String(p["id"])}`, `runs:thread:${String(p["id"])}`, `importable:${String(p["projectId"])}`, ...scopedTask(p)],
  ...each(["threads.implementPlan", "threads.compact", "threads.queue", "threads.send"], (p) => ["threads", `thread:${String(p["id"])}`, `runs:thread:${String(p["id"])}`]),
  // Removing a queued review message returns its comments to the review.
  "threads.unqueue": (p) => ["threads", `thread:${String(p["id"])}`, `runs:thread:${String(p["id"])}`, `comments:thread:${String(p["id"])}`],
  "review.commitThread": (p) => ["workspace-diff", `threaddiff:${String(p["threadId"])}`, `threadlog:${String(p["threadId"])}`, `thread:${String(p["threadId"])}`, "threads", "orchestration"],
  "review.pushThread": (p) => ["workspace-diff", "threads", `thread:${String(p["threadId"])}`, `threaddiff:${String(p["threadId"])}`, `threadlog:${String(p["threadId"])}`],
  "review.createThreadPr": (p) => ["threads", `thread:${String(p["threadId"])}`, `threaddiff:${String(p["threadId"])}`, `threadlog:${String(p["threadId"])}`],
  ...each(["schedules.create", "schedules.update", "schedules.delete", "schedules.run", "schedules.trigger"], () => ["schedules", "threads"]),
  ...each(["runs.start", "runs.send", "runs.close"], (p) => [
    "tasks",
    "inbox",
    "threads",
    taskTag(p),
    `runs:${String(p["taskId"])}`,
    `thread:${String(p["threadId"])}`,
    `runs:thread:${String(p["threadId"])}`,
  ]),
  ...each(["workspace.cleanup", "review.markReviewed"], (p) => ["tasks", taskTag(p), `diff:${String(p["taskId"])}`]),
  "review.commitProject": (p) => ["workspace-diff", `projectdiff:${String(p["projectId"])}`],
  "review.pushProject": (p) => ["workspace-diff", `projectlog:${String(p["projectId"])}`, "threads"],
  "review.commit": (p) => ["workspace-diff", `diff:${String(p["taskId"])}`, `log:${String(p["taskId"])}`, `snapshots:${String(p["taskId"])}`, taskTag(p), "tasks"],
  ...each(["review.push", "review.createPr"], (p) => [`diff:${String(p["taskId"])}`, `log:${String(p["taskId"])}`, `snapshots:${String(p["taskId"])}`, taskTag(p), "tasks"]),
};

export function invalidatesFor<M extends RpcMethod>(method: M, params: RpcParams<M>): string[] {
  const fixed = fixedInvalidations[method];
  if (fixed) return [...fixed];
  const rule = mutationRules[method];
  if (rule) return rule(params);
  if (method.startsWith("agents.updates.")) return ["agent-updates", ...(method === "agents.updates.install" ? ["system", "models"] : [])];
  if (method.startsWith("projects.")) return ["projects", "tasks"];
  const p = (params ?? {}) as Record<string, unknown>;
  if (method.startsWith("tasks.comments.")) return [`task-comments:${String(p["taskId"])}`];
  if (workspaceMutations.has(method)) return workspaceMutationTags(String(p["id"]));
  return idInvalidations[method]?.(p) ?? [];
}
