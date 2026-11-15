import type { ThreadSummary } from "@openorc/protocol";
import { expect, it } from "vitest";
import { conversationEmptyHint, conversationEmptyTitle, conversationLocation, linkFolder, toolPathBase, workspaceDestination } from "./conversation-status-presentation";

it("keeps task instructions ahead of the workspace hint", () => {
  expect(conversationEmptyHint({ task: true, workspace: true })).toBe("Your task description is included. Add any direction below, or send to start.");
  expect(conversationEmptyTitle({ count: 2, firstTaskRun: true })).toBe("Loading transcript");
  expect(workspaceDestination({ mode: "current", rootPath: "/checkout", taskPath: "/task" })).toBe("/checkout");
});
it("names an OpenOrc Cloud thread's place as the cloud, with no folder on this Mac", () => {
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
  const owner = { brain: "hosted" as const, reach: "live" as const, heardAt: 0 };
  const thread = { workspaceMode: "worktree", branch: "openorc/footer", worktreePath: null, owner } as ThreadSummary;
  expect(conversationLocation({ scope: { kind: "thread", thread }, project, mode: "worktree", basePath: "/site", checkoutBranch: "main" })).toEqual({
    label: "OpenOrc Cloud",
    branch: "openorc/footer",
    cloud: true,
  });
  expect(conversationLocation({ scope: { kind: "thread", thread: { ...thread, owner: undefined } }, project, mode: "worktree", basePath: "/worktrees/footer", checkoutBranch: "main" })).toEqual({
    label: "Worktree",
    branch: "openorc/footer",
    directory: "/worktrees/footer",
  });
});

it("opens an OpenOrc Cloud thread's file links nowhere on this Mac, and a thread's here in its own folder", () => {
  const owner = { brain: "hosted" as const, reach: "live" as const, heardAt: 0 };
  const cloud = { worktreePath: null, workingDirectory: null, owner } as unknown as ThreadSummary;
  expect(linkFolder({ kind: "thread", thread: cloud }, { rootPath: "/site" })).toBeNull();
  expect(toolPathBase({ kind: "thread", thread: cloud }, "/site")).toBeNull();
  const here = { worktreePath: null, workingDirectory: null } as unknown as ThreadSummary;
  expect(linkFolder({ kind: "thread", thread: here }, { rootPath: "/site" })).toBe("/site");
  expect(linkFolder({ kind: "thread", thread: { ...here, worktreePath: "/site/.wt/a" } }, { rootPath: "/site" })).toBe("/site/.wt/a");
  expect(toolPathBase({ kind: "thread", thread: here }, "/site")).toBe("/site");
});
