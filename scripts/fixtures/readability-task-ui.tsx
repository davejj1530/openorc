import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import type { Project, ReviewComment, RpcMethod, RpcParams, RpcResults, Task, TaskComment, TeamTaskView } from "@openorc/protocol";
import { TaskDocument, type TaskDocumentHandle } from "../../apps/desktop/src/renderer/src/views/TaskDocument";
import { ReviewPanel } from "../../apps/desktop/src/renderer/src/panels/ReviewPanel";
import { TaskDraftProvider } from "../../apps/desktop/src/renderer/src/lib/task-draft-context";
import { core } from "../../apps/desktop/src/renderer/src/lib/rpc";
import { queryClient } from "../../apps/desktop/src/renderer/src/lib/query";
import { useTheme } from "../../apps/desktop/src/renderer/src/lib/theme";
import "../../apps/desktop/src/renderer/src/app.css";

const project: Project = {
  id: "project",
  name: "Readability fixture",
  rootPath: "/fixture",
  defaultBranch: "main",
  gitRemote: "git@github.com:example/fixture.git",
  settings: { setupScript: null, worktreeInclude: [], branchPrefix: "openorc", detectedConfigs: [] },
  createdAt: 0,
  updatedAt: 0,
};
let task: Task = {
  id: "task",
  projectId: "project",
  title: "Keep review and saves understandable",
  spec: "## Review checklist\n\nKeep the current selection and save the final edit.",
  status: "review",
  priority: "medium",
  labels: ["readability"],
  workspaceMode: "worktree",
  baseRef: "a".repeat(40),
  baseSha: "a".repeat(40),
  branch: "assignment",
  worktreePath: null,
  parentTaskId: null,
  threadId: "thread",
  executionThreadId: null,
  origin: "agent",
  reviewedSnapshotId: null,
  costUsd: 0,
  createdAt: Date.now(),
  updatedAt: 0,
  completedAt: null,
};
const team: TeamTaskView = {
  taskId: task.id,
  threadId: "thread",
  teamName: "Fixture team",
  members: [],
  managerKey: "lead",
  memberKey: null,
  dependencyTaskIds: [],
  policy: { requested: "trusted", effective: "trusted", pendingRestart: false, runs: [] },
  start: { allowed: false, reason: "Already accepted" },
  review: { allowed: true, reason: null },
  export: { allowed: true, reason: null, branch: "assignment" },
  admissions: [],
  claimedCommentIds: [],
  assignments: [],
  working: false,
};
const comment: ReviewComment = {
  id: "comment",
  taskId: task.id,
  threadId: null,
  snapshotId: null,
  path: "example.ts",
  startLine: null,
  startSide: null,
  line: 1,
  side: "new",
  lineText: "const readable = true;",
  body: "Keep this comment selected",
  sentInRunId: null,
  sentMessageId: null,
  createdAt: 1,
};
const discussion: TaskComment[] = [];
const calls: { method: RpcMethod; params: unknown }[] = [];
let failSave = false;
let notifyTask = (_task: Task) => {};
Object.assign(window, { openorc: { platform: "darwin", openExternal: () => {}, revealFile: () => {} } });
core.call = async <M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> => {
  calls.push({ method, params });
  let result: unknown;
  switch (method) {
    case "tasks.get":
      result = task;
      break;
    case "tasks.update": {
      if (failSave) throw new Error("Fixture save unavailable");
      const input = params as RpcParams<"tasks.update">;
      task = { ...task, ...input.patch };
      notifyTask(task);
      result = task;
      break;
    }
    case "tasks.executionThread":
      result = null;
      break;
    case "runs.listForTask":
      result = [];
      break;
    case "tasks.forwarding":
      result = { forwarding: null };
      break;
    case "orchestration.taskState":
      result = team;
      break;
    case "agents.models":
      result = [];
      break;
    case "tasks.comments.list":
      result = { comments: discussion, attempts: [] };
      break;
    case "tasks.comments.post": {
      const input = params as RpcParams<"tasks.comments.post">;
      discussion.push({
        id: "note",
        taskId: task.id,
        requestKey: input.requestKey,
        body: input.body,
        recipients: input.recipients ?? [],
        replyTo: input.replyTo ?? null,
        source: input.source,
        context: task.spec ?? "",
        createdAt: Date.now(),
      });
      result = { comment: discussion.at(-1), attempts: [] };
      break;
    }
    case "system.info":
      result = { gh: { installed: true, path: "/fixture/gh" } };
      break;
    case "review.comments.list":
      result = [comment];
      break;
    case "review.diff":
      result = {
        baseSha: null,
        patch: "diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-const flag = true;\n+const readable = true;\n",
        files: [{ path: "example.ts", status: "modified", oldPath: null }],
        since: null,
      };
      break;
    case "review.commit":
      throw new Error("Fixture commit unavailable");
    default:
      throw new Error(`Unexpected fixture RPC: ${method}`);
  }
  return result as RpcResults[M];
};
useTheme.getState().set("light");

function App() {
  const [currentTask, setTask] = useState(task);
  const [view, setView] = useState<"document" | "review">("document");
  const document = useRef<TaskDocumentHandle>(null);
  notifyTask = setTask;
  Object.assign(window, {
    taskSmoke: {
      view: setView,
      failSave: (value: boolean) => {
        failSave = value;
      },
      calls,
      theme: (value: "light" | "dark") => useTheme.getState().set(value),
      flush: () => document.current?.flush(),
    },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <TaskDraftProvider taskId={task.id}>
        <main className="task-workspace bg-surface text-ink" style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
          {view === "document" ? <TaskDocument ref={document} task={currentTask} project={project} /> : <ReviewPanel task={currentTask} project={project} />}
        </main>
      </TaskDraftProvider>
    </QueryClientProvider>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
