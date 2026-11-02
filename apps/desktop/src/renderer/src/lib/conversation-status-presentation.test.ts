import { expect, it } from "vitest";
import type { ThreadSummary } from "@openorc/protocol";
import {
  conversationEmptyHint,
  conversationLocation,
  conversationEmptyTitle,
  durableActionLabel,
  teamActorStateLabel,
  teamMessageHint,
  workspaceDestination,
} from "./conversation-status-presentation";

it("keeps task instructions ahead of the workspace hint", () => {
  expect(conversationEmptyHint({ task: true, workspace: true })).toBe("Your task description is included. Add any direction below, or send to start.");
  expect(conversationEmptyTitle({ count: 2, firstTaskRun: true })).toBe("Loading transcript");
  expect(workspaceDestination({ mode: "current", rootPath: "/checkout", taskPath: "/task" })).toBe("/checkout");
});
it("keeps the active send explanation and preserves an empty steer reason", () => {
  expect(teamMessageHint({ active: true, hasMembers: true, hasMention: false, canSteer: false, steerReason: "", mentionHint: "mention" })).toBe(
    "Enter sends to the active turn where supported. Queue keeps it for the next turn. ",
  );
  expect(teamMessageHint({ active: false, hasMembers: true, hasMention: false, canSteer: false, steerReason: null, mentionHint: "mention" })).toBe("mention");
});
it("shows pending attention and in-flight actions before held/retry states", () => {
  expect(teamActorStateLabel({ pending: true, heldForPlan: true, stateLabel: "Completed" })).toBe("Needs you");
  expect(durableActionLabel({ working: true, pending: true, labels: ["Run", "Retry", "Running"] })).toBe("Running");
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
