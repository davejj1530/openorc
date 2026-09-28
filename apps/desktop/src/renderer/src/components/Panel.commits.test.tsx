import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Commit, Project, PushState, RpcMethod, RpcParams, RpcResults, ThreadSummary } from "@openorc/protocol";
import { core } from "../lib/rpc";
import { queryClient } from "../lib/query";
import { useLayout } from "../lib/layout";
import { Panel } from "./Panel";

vi.mock("../lib/window", () => ({ useTrafficLights: () => false, useWindowsControls: () => false }));
vi.mock("../lib/browser-preview", () => ({ CoversPreview: () => null, useBrowserPreview: () => undefined }));

const project: Project = {
  id: "project",
  name: "Site",
  rootPath: "/tmp/site",
  gitRemote: "git@github.com:openorc/site.git",
  defaultBranch: "main",
  settings: { setupScript: null, worktreeInclude: [], branchPrefix: "openorc", detectedConfigs: [] },
  createdAt: 0,
  updatedAt: 0,
};
// A checkout conversation that began after the branch's last commit was made elsewhere.
const thread = {
  id: "thread",
  projectId: project.id,
  title: "Follow-up",
  workspaceMode: "current",
  worktreePath: null,
  baseSha: "a".repeat(40),
  createdAt: 5_000,
  teamInstanceId: null,
  prUrl: null,
} as ThreadSummary;
const commit: Commit = { sha: "b".repeat(40), author: "David C", at: 1_000, subject: "fix: mentions skip the probability check" };
let state: PushState;
let log: Commit[];
let changed: string[];

beforeEach(() => {
  log = [commit];
  changed = [];
  state = { branch: "feat/bots", blocked: null, published: true, unpushedCount: 1, unpushed: [commit.sha] };
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
  useLayout.setState({ panelOpen: true, panelTab: "commits" });
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M): Promise<RpcResults[M]> => {
    if (method === "projects.git") return "ready" as RpcResults[M];
    if (method === "git.threadLog" || method === "git.projectLog") return log as RpcResults[M];
    if (method === "git.threadPushState" || method === "git.projectPushState") return state as RpcResults[M];
    if (method === "review.pushProject") {
      state = { ...state, unpushedCount: 0, unpushed: [] };
      return { remote: "origin", branch: "feat/bots" } as RpcResults[M];
    }
    if (method === "review.threadDiff" || method === "review.projectDiff")
      return { baseSha: null, patch: "", files: changed.map((path) => ({ path, status: "modified", oldPath: null })), since: null } as RpcResults[M];
    if (method === "system.info") return { gh: { installed: true, path: "/usr/bin/gh" } } as unknown as RpcResults[M];
    return [] as unknown as RpcResults[M];
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});

const mount = (context: Parameters<typeof Panel>[0]["context"]) =>
  render(
    <QueryClientProvider client={queryClient}>
      <Panel context={context} />
    </QueryClientProvider>,
  );

it("offers Push in a conversation for commits origin lacks, even ones made before it began", async () => {
  mount({ kind: "thread", thread, project });
  expect(await screen.findByRole("button", { name: "Push 1 commit" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Commits" })).toBeTruthy();
});

it("offers Push on a new thread's panel after committing the checkout", async () => {
  useLayout.setState({ panelTab: "changes" });
  mount({ kind: "newthread", project, workingDirectory: project.rootPath, changes: true });
  // Opened by the reader, the tab stays once there's nothing left to push.
  fireEvent.click(await screen.findByRole("tab", { name: "Commits" }));
  fireEvent.click(await screen.findByRole("button", { name: "Push 1 commit" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("review.pushProject", { projectId: project.id } satisfies RpcParams<"review.pushProject">));
  expect(await screen.findByText("Pushed feat/bots to origin")).toBeTruthy();
});

it("offers Push in a worktree conversation whose unpushed commits come from before it began", async () => {
  // Started from local commits origin lacks: its own log, from its base, is empty.
  log = [];
  mount({ kind: "thread", thread: { ...thread, workspaceMode: "worktree", worktreePath: "/tmp/site-wt" }, project });
  expect(await screen.findByRole("button", { name: "Push 1 commit" })).toBeTruthy();
  expect(screen.getByText("No commits from this thread yet")).toBeTruthy();
});

it("offers no Commit, Push or pull request in a pull request's copy under review", async () => {
  changed = ["README.md"];
  useLayout.setState({ panelTab: "changes" });
  mount({ kind: "thread", thread: { ...thread, workspaceMode: "worktree", worktreePath: "/tmp/review-copy", branch: null }, project });
  expect(await screen.findByText("README.md")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Commit" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "Commits" })).toBeNull();
  expect(core.call).not.toHaveBeenCalledWith("git.threadPushState", expect.anything());
});
