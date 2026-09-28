import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Project, ReviewComment, RpcMethod, RpcParams, RpcResults, Task, TeamTaskView } from "@openorc/protocol";
import { ReviewPanel } from "./ReviewPanel";
import { core } from "../lib/rpc";
import { queryClient } from "../lib/query";
import { TaskDraftProvider } from "../lib/task-draft-context";
import { readTeamTaskRequest } from "../lib/team-task-actions";

vi.mock("../components/DiffView", () => ({ DiffView: () => <div data-testid="diff" /> }));
const project: Project = {
  id: "project",
  name: "Site",
  rootPath: "/repo",
  defaultBranch: "main",
  gitRemote: "git@github.com:example/repo.git",
  settings: { setupScript: null, worktreeInclude: [], branchPrefix: "openorc", detectedConfigs: [] },
  createdAt: 0,
  updatedAt: 0,
};
const task: Task = {
  id: "task",
  projectId: "project",
  title: "Improve review",
  spec: "Keep behavior",
  status: "review",
  priority: "none",
  labels: [],
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
  createdAt: 0,
  updatedAt: 0,
  completedAt: null,
};
const comment: ReviewComment = {
  id: "one",
  taskId: "task",
  threadId: null,
  snapshotId: null,
  path: "app.ts",
  startLine: null,
  startSide: null,
  line: 1,
  side: "new",
  lineText: null,
  body: "Keep this selection",
  sentInRunId: null,
  sentMessageId: null,
  createdAt: 1,
};
const patch = "diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-old\n+new\n";
let team: TeamTaskView;
let comments: ReviewComment[];
let failures: Map<RpcMethod, string>;
beforeEach(() => {
  localStorage.clear();
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
  comments = [comment];
  failures = new Map();
  team = {
    taskId: "task",
    threadId: "thread",
    teamName: "Team",
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
  vi.stubGlobal("openorc", { openExternal: vi.fn(), revealFile: vi.fn() });
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M, _params: RpcParams<M>): Promise<RpcResults[M]> => {
    const failure = failures.get(method);
    if (failure) throw new Error(failure);
    if (method === "orchestration.taskState") return team as RpcResults[M];
    if (method === "review.diff") return { baseSha: null, patch, files: [{ path: "app.ts", status: "modified", oldPath: null }], since: null } as RpcResults[M];
    if (method === "review.comments.list") return comments as RpcResults[M];
    if (method === "system.info") return { gh: { installed: true, path: "/fixture/gh" } } as RpcResults[M];
    if (method === "orchestration.review.send") return { admissionId: "accepted", task: team } as RpcResults[M];
    throw new Error(`Unexpected RPC ${method}`);
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount() {
  return render(
    <QueryClientProvider client={queryClient}>
      <TaskDraftProvider taskId={task.id}>
        <ReviewPanel task={task} project={project} />
      </TaskDraftProvider>
    </QueryClientProvider>,
  );
}

it("keeps unsent selections and dialog drafts through commit, push and PR errors", async () => {
  failures.set("review.commit", "Commit rejected");
  failures.set("review.push", "Push rejected");
  failures.set("review.createPr", "PR rejected");
  mount();
  const selected = await screen.findByRole("checkbox", { name: /Keep this selection/ });
  fireEvent.click(selected);
  fireEvent.click(screen.getByRole("button", { name: "Commit" }));
  const commitDialog = await screen.findByRole("dialog", { name: "Commit all changes" });
  fireEvent.change(within(commitDialog).getByLabelText("Message"), { target: { value: "  preserve my message  " } });
  fireEvent.click(within(commitDialog).getByRole("button", { name: "Commit" }));
  expect(await within(commitDialog).findByText("Commit rejected")).toBeTruthy();
  expect(within(commitDialog).getByLabelText("Message")).toHaveProperty("value", "  preserve my message  ");
  expect(core.call).toHaveBeenCalledWith("review.commit", { taskId: task.id, message: "preserve my message" });
  fireEvent.click(within(commitDialog).getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Push" }));
  expect(await screen.findByText("Push rejected")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "PR" }));
  const prDialog = await screen.findByRole("dialog", { name: "Open a pull request" });
  fireEvent.change(within(prDialog).getByLabelText("Title"), { target: { value: "Draft PR title" } });
  fireEvent.click(within(prDialog).getByRole("button", { name: "Create" }));
  expect(await within(prDialog).findByText("PR rejected")).toBeTruthy();
  expect(within(prDialog).getByLabelText("Title")).toHaveProperty("value", "Draft PR title");
  fireEvent.click(within(prDialog).getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("checkbox", { name: /Keep this selection/ })).toHaveProperty("checked", true);
});

it("retries the exact saved review request when more comments arrive after a lost response", async () => {
  failures.set("orchestration.review.send", "Response lost");
  mount();
  fireEvent.click(await screen.findByRole("checkbox", { name: /Keep this selection/ }));
  fireEvent.click(screen.getByRole("button", { name: "Send 1 selected comment" }));
  expect(await screen.findByText("Response lost")).toBeTruthy();
  const pending = readTeamTaskRequest({ taskId: task.id, kind: "review" });
  comments = [comment, { ...comment, id: "two", body: "Added later", createdAt: 2 }];
  act(() => {
    queryClient.setQueryData(["review.comments.list", { taskId: task.id }], comments);
  });
  expect(await screen.findByRole("checkbox", { name: /Added later/ })).toHaveProperty("checked", false);
  failures.delete("orchestration.review.send");
  fireEvent.click(screen.getByRole("button", { name: "Retry review request" }));
  await waitFor(() => expect(readTeamTaskRequest({ taskId: task.id, kind: "review" })).toBeNull());
  const calls = vi.mocked(core.call).mock.calls.filter(([method]) => method === "orchestration.review.send");
  expect(calls).toHaveLength(2);
  expect(calls[0]?.[1]).toEqual({ taskId: task.id, requestKey: pending?.requestKey, commentIds: ["one"] });
  expect(calls[1]?.[1]).toEqual(calls[0]?.[1]);
});

it("shows immutable retained comments while assignment export is blocked", async () => {
  team.export = { allowed: false, reason: "Wait for integration", branch: "assignment" };
  team.admissions = [
    {
      id: "admission",
      requestKey: "old",
      kind: "review",
      createdAt: 2,
      state: "completed",
      executionId: "execution",
      actorId: "actor",
      memberKey: null,
      role: "assignee",
      result: null,
      error: null,
      reviewBatch: { id: "batch", comments: [{ ...comment, taskId: task.id, body: "Retained original" }] },
      retry: { allowed: false, reason: null },
    },
  ];
  comments = [];
  mount();
  expect(await screen.findByText("Retained original")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Commit" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Push" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Remove comment" })).toHaveProperty("disabled", true);
  expect(screen.getByText("Wait for integration")).toBeTruthy();
});
