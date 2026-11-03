import type { ThreadSummary } from "@openorc/protocol";
import { expect, it } from "vitest";
import { conversationEmptyHint, conversationEmptyTitle, conversationLocation, workspaceDestination } from "./conversation-status-presentation";

it("keeps task instructions ahead of the workspace hint", () => {
  expect(conversationEmptyHint({ task: true, workspace: true })).toBe("Your task description is included. Add any direction below, or send to start.");
  expect(conversationEmptyTitle({ count: 2, firstTaskRun: true })).toBe("Loading transcript");
  expect(workspaceDestination({ mode: "current", rootPath: "/checkout", taskPath: "/task" })).toBe("/checkout");
});
it("names a cloud thread's place as the cloud, with the worktree its changes arrive in", () => {
  const project = {
    id: "project",
    name: "Site",
    rootPath: "/site",
    gitRemote: null,
    defaultBranch: "main",
    settings: { setupScript: null, worktreeInclude: [], branchPrefix: "openorc", detectedConfigs: [] },
    createdAt: 0,
    updatedAt: 0,
  };
  const thread = { workspaceMode: "worktree", branch: "openorc/footer", cloud: { provider: "vercel", state: "ready", step: null, setup: false, error: null } } as ThreadSummary;
  expect(conversationLocation({ scope: { kind: "thread", thread }, project, mode: "worktree", basePath: "/worktrees/footer", checkoutBranch: "main" })).toEqual({
    label: "Cloud",
    branch: "openorc/footer",
    directory: "/worktrees/footer",
    cloud: true,
  });
  expect(conversationLocation({ scope: { kind: "thread", thread: { ...thread, cloud: null } }, project, mode: "worktree", basePath: "/worktrees/footer", checkoutBranch: "main" }).label).toBe(
    "Worktree",
  );
});
