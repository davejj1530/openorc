import { expect, it } from "vitest";
import {
  conversationEmptyHint,
  conversationEmptyTitle,
  conversationPlaceholder,
  durableActionLabel,
  teamActorStateLabel,
  teamMessageHint,
  workspaceDestination,
} from "./conversation-status-presentation";

it("puts first task direction before active-turn placeholder states", () => {
  expect(conversationPlaceholder({ firstTaskRun: true, working: true, canSteer: true, agent: undefined })).toBe("Add direction, or send to start this task…");
  expect(conversationPlaceholder({ firstTaskRun: false, working: true, canSteer: false, agent: undefined })).toBe("Queue a message for when it finishes…");
});
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
