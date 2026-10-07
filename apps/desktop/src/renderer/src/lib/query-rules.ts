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
  "files.read": ({ scope }) => ["workspace-diff", ...folderTags(scope)],
  "files.search": () => ["files"],
  // Saves, commits, terminal commands and window focus rerun a find; an agent's edits wait until the results show again.
  "files.find": () => ["files", "workspace-diff"],
};

export const readRules: Rules = {
  ...fileReadRules,
  "instructions.list": ({ threadId }) => ["instructions", "workspace-diff", `thread:${threadId}`],
  "review.comments.list": reviewCommentTags,
};

export const mutationRules: Rules = {
  "review.comments.add": reviewCommentTags,
  "review.comments.remove": reviewCommentTags,
  "review.comments.send": ({ threadId, taskId }) => [...reviewCommentTags({ threadId, taskId }), "threads", `thread:${threadId}`, ...(taskId ? ["tasks", `task:${taskId}`] : [])],
};
