import { describe, expect, it } from "vitest";
import { teamSendDisabledReason, type TeamSendAvailability } from "./team-send-availability";

const ready: TeamSendAvailability = {
  retained: false,
  active: false,
  archived: false,
  refreshFailed: false,
  stopping: false,
  teamEnabled: true,
};

describe("team send availability", () => {
  it("keeps the original reason priority when several conditions overlap", () => {
    expect(teamSendDisabledReason({ ...ready, retained: true, archived: true, refreshFailed: true, stopping: true, teamEnabled: false })).toBe(
      "This conversation was deleted. Start or review the saved task to continue.",
    );
    expect(teamSendDisabledReason({ ...ready, archived: true, refreshFailed: true, stopping: true })).toBe("Unarchive this task from its menu before sending.");
    expect(teamSendDisabledReason({ ...ready, refreshFailed: true, stopping: true })).toBe("Refresh team activity before sending.");
    expect(teamSendDisabledReason({ ...ready, stopping: true, teamEnabled: false })).toBe("Wait for the team to stop.");
  });

  it("preserves a supplied empty reason and only falls back for nullish availability", () => {
    expect(teamSendDisabledReason({ ...ready, teamEnabled: false, availabilityReason: "" })).toBe("");
    expect(teamSendDisabledReason({ ...ready, teamEnabled: false, availabilityReason: null })).toBe("Checking team availability…");
    expect(teamSendDisabledReason({ ...ready, teamEnabled: false, availabilityReason: "Team is off." })).toBe("Team is off.");
  });

  it("allows an active retained conversation and an available idle team", () => {
    expect(teamSendDisabledReason(ready)).toBeNull();
    expect(teamSendDisabledReason({ ...ready, retained: true, active: true, archived: true, teamEnabled: false })).toBeNull();
  });
});
