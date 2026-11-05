import type { ThreadSummary } from "@openorc/protocol";
import { expect, it } from "vitest";
import { conversationEmptyHint, conversationEmptyTitle, conversationLocation, linkFolder, workspaceDestination } from "./conversation-status-presentation";

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
it("names no folder on this Mac for a thread on the cloud brain, until it is open here in its read-only copy", () => {
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
  const owner = { brain: "cloud" as const, reach: "live" as const, heardAt: 0 };
  const thread = {
    workspaceMode: "worktree",
    branch: "openorc/footer",
    worktreePath: null,
    owner,
    cloud: { provider: "vercel", state: "ready", step: null, setup: false, error: null },
  } as ThreadSummary;
  expect(conversationLocation({ scope: { kind: "thread", thread }, project, mode: "worktree", basePath: "/site", checkoutBranch: "main" })).toEqual({
    label: "Cloud",
    branch: "openorc/footer",
    cloud: true,
  });
  const open = { ...thread, worktreePath: "/mirrors/footer", owner: { ...owner, mirror: true } };
  expect(conversationLocation({ scope: { kind: "thread", thread: open }, project, mode: "worktree", basePath: "/mirrors/footer", checkoutBranch: "main" }).directory).toBe("/mirrors/footer");
});

it("opens a cloud brain thread's file links only in its read-only copy here, never in the Mac's project folder", () => {
  const owner = { brain: "cloud" as const, reach: "live" as const, heardAt: 0 };
  const cloud = { worktreePath: null, workingDirectory: null, owner } as unknown as ThreadSummary;
  expect(linkFolder({ kind: "thread", thread: cloud }, { rootPath: "/site" })).toBeNull();
  expect(linkFolder({ kind: "thread", thread: { ...cloud, worktreePath: "/mirrors/footer" } }, { rootPath: "/site" })).toBe("/mirrors/footer");
  const here = { worktreePath: null, workingDirectory: null } as unknown as ThreadSummary;
  expect(linkFolder({ kind: "thread", thread: here }, { rootPath: "/site" })).toBe("/site");
  expect(linkFolder({ kind: "thread", thread: { ...here, worktreePath: "/site/.wt/a" } }, { rootPath: "/site" })).toBe("/site/.wt/a");
});
