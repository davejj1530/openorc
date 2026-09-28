import { describe, expect, it } from "vitest";
import {
  deleteButtonLabel,
  teamMoveBlockedReason,
  teamMoveButton,
  teamMoveTitle,
  teamTaskSubmitLabel,
  threadDeleteBlockedReason,
  threadDeletionDescription,
  threadMoveLabel,
} from "./team-action-presentation";

const availableMove = { loadFailed: false, loading: false, available: true, move: { allowed: true }, hasRecovery: false, savedError: null, hasPending: false };

describe("team action presentation priority", () => {
  it("shows load failure before a pending load or saved move", () => {
    expect(teamMoveBlockedReason({ ...availableMove, loadFailed: true, loading: true, hasPending: true })).toBe("Could not check the team workspace. Refresh team status to retry.");
    expect(teamMoveBlockedReason({ ...availableMove, loading: true, available: false })).toBe("Checking team workspace…");
  });
  it("requires availability before recovery but permits retry of a saved move", () => {
    expect(teamMoveBlockedReason({ ...availableMove, move: undefined, hasRecovery: true, hasPending: true })).toBe("Team move availability is missing. Refresh team status to retry.");
    expect(teamMoveBlockedReason({ ...availableMove, savedError: "storage failed", hasPending: true })).toBe("storage failed");
    expect(teamMoveBlockedReason({ ...availableMove, savedError: "storage failed", hasRecovery: true, hasPending: true, move: { allowed: false } })).toBeNull();
  });
  it("preserves an explicitly empty move reason", () => {
    expect(teamMoveBlockedReason({ ...availableMove, move: { allowed: false, reason: "" } })).toBe("");
    expect(teamMoveBlockedReason({ ...availableMove, move: { allowed: false } })).toBe("Move is currently unavailable for this team.");
  });
  it("places confirmed outcome before cancellation and saved move", () => {
    expect(teamMoveTitle({ notice: "confirmed", cancelling: true, pending: true, to: "current" })).toBe("Workspace move confirmed");
    expect(teamMoveButton({ cancelPending: true, movePending: true, cancelling: true, pending: true })).toBe("Cancelling…");
    expect(threadMoveLabel({ cancelling: true, pending: true, mode: "worktree" })).toBe("Retry move cancellation");
  });
  it("reports thread loading and absence before team and storage state", () => {
    expect(threadDeleteBlockedReason({ loading: true, exists: false, teamLoading: true, savedError: "storage failed" })).toBe("Checking this thread…");
    expect(threadDeleteBlockedReason({ loading: false, exists: false, teamLoading: true, savedError: "storage failed" })).toBe("This thread no longer exists.");
    expect(threadDeleteBlockedReason({ loading: false, exists: true, teamLoading: false, savedError: "" })).toBeNull();
  });
  it("shows pending operations before retry or task counts", () => {
    expect(deleteButtonLabel({ working: true, pending: true, count: 3 })).toBe("Deleting…");
    expect(deleteButtonLabel({ working: false, pending: true, count: 3 })).toBe("Retry delete");
    expect(deleteButtonLabel({ working: false, pending: false, count: 3 })).toBe("Delete 3 tasks");
    expect(teamTaskSubmitLabel({ working: true, pending: true, kind: "review" })).toBe("Submitting…");
    expect(teamTaskSubmitLabel({ working: false, pending: true, kind: "review" })).toBe("Retry saved request");
    expect(teamTaskSubmitLabel({ working: false, pending: true, kind: "start" })).toBe("Retry start request");
  });
  it("preserves the singular retained task explanation", () => {
    expect(threadDeletionDescription({ team: true, tasks: 1 })).toBe(
      "This conversation disappears from your lists. Its 1 saved task keeps the team, its activity, history and workspaces. Continue from the task’s Activity tab.",
    );
  });
});
