import { describe, expect, it } from "vitest";
import { teamDeleteReason, teamLifecycleReason, teamMoveReason, type TeamDeleteReasonInput, type TeamLifecycleReasonInput, type TeamMoveReasonInput } from "./thread-action-reasons";

const move: TeamMoveReasonInput = {
  team: true,
  loadFailed: false,
  loaded: true,
  availability: { allowed: true, reason: null },
  hasRecovery: false,
  savedError: null,
  hasPendingRequest: false,
};
const deletion: TeamDeleteReasonInput = { ...move };
const lifecycle: TeamLifecycleReasonInput = { team: true, loadFailed: false, loaded: true, hasOpenExecution: false, hasPendingPublication: false };

describe("thread action reasons", () => {
  it("keeps move recovery, stale reports and local errors in their existing priority", () => {
    expect(teamMoveReason({ ...move, team: false, loadFailed: true })).toBeNull();
    expect(teamMoveReason({ ...move, loadFailed: true, savedError: "Saved failure" })).toBe("Could not check team move availability. Refresh team status to retry.");
    expect(teamMoveReason({ ...move, loaded: false })).toBe("Checking team move availability…");
    expect(teamMoveReason({ ...move, availability: undefined, savedError: "Saved failure" })).toBe("Team move availability is missing. Refresh team status to retry.");
    expect(teamMoveReason({ ...move, savedError: "Saved failure", hasPendingRequest: true })).toBe("Saved failure");
    expect(teamMoveReason({ ...move, savedError: "Saved failure", hasRecovery: true })).toBeNull();
    expect(teamMoveReason({ ...move, availability: { allowed: false, reason: "" } })).toBe("");
    expect(teamMoveReason({ ...move, availability: { allowed: false, reason: null } })).toBe("Move is currently unavailable for this team.");
  });

  it("keeps delete recovery ahead of stale availability and local errors", () => {
    expect(teamDeleteReason({ ...deletion, team: false, loadFailed: true })).toBeNull();
    expect(teamDeleteReason({ ...deletion, loadFailed: true, hasRecovery: true })).toBe("Could not check team delete availability. Refresh team status to retry.");
    expect(teamDeleteReason({ ...deletion, loaded: false })).toBe("Checking team delete availability…");
    expect(teamDeleteReason({ ...deletion, hasRecovery: true, availability: undefined, savedError: "Saved failure" })).toBeNull();
    expect(teamDeleteReason({ ...deletion, availability: undefined })).toBe("Team delete availability is missing. Refresh team status to retry.");
    expect(teamDeleteReason({ ...deletion, savedError: "Saved failure", hasPendingRequest: true })).toBe("Saved failure");
    expect(teamDeleteReason({ ...deletion, availability: { allowed: false, reason: "" } })).toBe("");
    expect(teamDeleteReason({ ...deletion, availability: { allowed: false, reason: null } })).toBe("Delete is currently unavailable for this team.");
  });

  it("blocks lifecycle changes for an open execution before retained publication", () => {
    expect(teamLifecycleReason({ ...lifecycle, team: false, loadFailed: true })).toBeNull();
    expect(teamLifecycleReason({ ...lifecycle, loadFailed: true, hasOpenExecution: true })).toBe("Could not check team activity. Retry before organizing this task.");
    expect(teamLifecycleReason({ ...lifecycle, loaded: false })).toBe("Checking team activity…");
    expect(teamLifecycleReason({ ...lifecycle, hasOpenExecution: true, hasPendingPublication: true })).toBe("Finish or stop this team execution before archiving or snoozing.");
    expect(teamLifecycleReason({ ...lifecycle, hasPendingPublication: true })).toBe("Resolve the retained integration details before archiving or snoozing.");
    expect(teamLifecycleReason(lifecycle)).toBeNull();
  });
});
