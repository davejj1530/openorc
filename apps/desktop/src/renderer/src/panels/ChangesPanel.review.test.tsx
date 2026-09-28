import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Project, ReviewComment, RpcMethod, RpcParams, RpcResults, Task, ThreadSummary } from "@openorc/protocol";
import type { CommentLocation } from "../components/DiffView";
import { ChangesPanel } from "./ChangesPanel";
import { core } from "../lib/rpc";
import { queryClient } from "../lib/query";

/** The diff viewer's own rendering is covered elsewhere; this test drives what a click on a line number reports. */
const viewer = vi.hoisted(() => ({
  props: null as null | { commentRanges?: boolean; onRequestComment?: (location: CommentLocation) => void; onSubmitDraft?: (body: string) => void; comments?: unknown[] },
}));
vi.mock("../components/DiffView", () => ({
  DiffView: (props: NonNullable<typeof viewer.props>) => {
    viewer.props = props;
    return <div data-testid="diff" />;
  },
}));

const project: Project = {
  id: "project",
  name: "Site",
  rootPath: "/repo",
  defaultBranch: "main",
  gitRemote: null,
  settings: { setupScript: null, worktreeInclude: [], branchPrefix: "openorc", detectedConfigs: [] },
  createdAt: 0,
  updatedAt: 0,
};
const thread: ThreadSummary = {
  id: "thread",
  projectId: project.id,
  title: "Site",
  agent: "codex",
  model: null,
  effort: null,
  fastMode: false,
  mode: "act",
  permissionMode: "review",
  workspaceMode: "current",
  branch: null,
  worktreePath: null,
  baseSha: null,
  pinnedAt: null,
  seenAt: null,
  doneAt: null,
  snoozedUntil: null,
  prUrl: null,
  prState: null,
  forkedFromId: null,
  forkedAtRunId: null,
  draft: "",
  importedFrom: null,
  createdAt: 0,
  updatedAt: 0,
  lastActivityAt: 0,
  archivedAt: null,
  activity: "idle",
  unread: false,
  session: { status: "idle", message: null },
  context: null,
  queued: [],
  lastAgentEventAt: null,
  taskCount: 0,
  openTaskCount: 0,
};
const task = { id: "task", executionThreadId: thread.id } as Task;
const patch = ["diff --git a/src/app.ts b/src/app.ts", "--- a/src/app.ts", "+++ b/src/app.ts", "@@ -1,1 +1,1 @@", "-const a = 0;", "+const a = 1;"].join("\n");

let saved: ReviewComment[];
beforeEach(() => {
  saved = [];
  viewer.props = null;
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> => {
    if (method === "review.threadDiff") return { baseSha: null, patch, files: [{ path: "src/app.ts", status: "modified", oldPath: null }], since: null } as RpcResults[M];
    if (method === "system.info") return { gh: { installed: false, path: null } } as unknown as RpcResults[M];
    if (method === "review.comments.list") return saved as RpcResults[M];
    if (method === "review.comments.add") {
      const input = params as RpcParams<"review.comments.add">;
      const comment: ReviewComment = {
        id: `comment-${saved.length + 1}`,
        threadId: input.threadId ?? null,
        taskId: input.taskId ?? null,
        snapshotId: null,
        path: input.path,
        startLine: input.startLine,
        startSide: input.startSide,
        line: input.line,
        side: input.side,
        lineText: input.lineText,
        body: input.body,
        sentInRunId: null,
        sentMessageId: null,
        createdAt: saved.length + 1,
      };
      saved = [...saved, comment];
      return comment as RpcResults[M];
    }
    if (method === "review.comments.send") {
      const input = params as RpcParams<"review.comments.send">;
      saved = saved.map((comment) => (input.commentIds.includes(comment.id) ? { ...comment, sentMessageId: "message" } : comment));
      return { messageId: "message", sent: input.commentIds.length } as RpcResults[M];
    }
    return [] as unknown as RpcResults[M];
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});

const mount = (props: { thread: ThreadSummary; task?: Task }) =>
  render(
    <QueryClientProvider client={queryClient}>
      <ChangesPanel project={project} {...props} />
    </QueryClientProvider>,
  );

it("comments on a conversation's diff from a task screen and sends the comments to that conversation", async () => {
  mount({ thread, task });
  await screen.findByTestId("diff");
  act(() => viewer.props!.onRequestComment!({ path: "src/app.ts", startLine: null, startSide: null, line: 1, side: "new", lineText: "const a = 1;" }));
  act(() => viewer.props!.onSubmitDraft!("Name this constant."));

  await waitFor(() =>
    expect(core.call).toHaveBeenCalledWith("review.comments.add", {
      threadId: thread.id,
      taskId: task.id,
      path: "src/app.ts",
      startLine: null,
      startSide: null,
      line: 1,
      side: "new",
      lineText: "const a = 1;",
      body: "Name this constant.",
    }),
  );
  expect(await screen.findByText("Name this constant.")).toBeTruthy();

  fireEvent.click(await screen.findByRole("button", { name: "Send 1 to the conversation" }));
  expect(await screen.findByText("Queued 1 comment for this conversation.")).toBeTruthy();
  expect(core.call).toHaveBeenCalledWith("review.comments.send", { threadId: thread.id, taskId: task.id, commentIds: ["comment-1"] });
  await waitFor(() => expect(screen.queryByRole("button", { name: /Send \d+ to the conversation/ })).toBeNull());
  expect(screen.getByText("Sent")).toBeTruthy();
});

it("saves a range dragged across line numbers with its first and last lines", async () => {
  mount({ thread });
  await screen.findByTestId("diff");
  expect(viewer.props!.commentRanges).toBe(true);
  const range: CommentLocation = { path: "src/app.ts", startLine: 1, startSide: "old", line: 1, side: "new", lineText: "const a = 0;\nconst a = 1;" };
  act(() => viewer.props!.onRequestComment!(range));
  act(() => viewer.props!.onSubmitDraft!("Keep the old value."));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("review.comments.add", { threadId: thread.id, ...range, body: "Keep the old value." }));
  expect(await screen.findByText("src/app.ts:-1 to +1")).toBeTruthy();
});

it("keeps a team conversation's changes read-only", async () => {
  mount({ thread: { ...thread, teamInstanceId: "team" } as ThreadSummary });
  await screen.findByTestId("diff");
  expect(viewer.props!.onRequestComment).toBeUndefined();
  expect(core.call).not.toHaveBeenCalledWith("review.comments.list", expect.anything());
});

it("offers only Commit for uncommitted work, plus the pull request once one exists", async () => {
  const { unmount } = mount({ thread });
  expect(await screen.findByRole("button", { name: "Commit" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Push" })).toBeNull();
  expect(screen.queryByRole("button", { name: "PR" })).toBeNull();
  unmount();
  mount({ thread: { ...thread, prUrl: "https://github.com/openorc/site/pull/7", prState: "open" } });
  expect(await screen.findByRole("button", { name: "open" })).toBeTruthy();
});
