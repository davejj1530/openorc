import { describe, expect, it } from "vitest";
import { TEAM_ACTOR_TRANSITIONS, TEAM_ATTEMPT_TRANSITIONS, TEAM_EXECUTION_TRANSITIONS, type TeamActorRecord, type TeamAttemptRecord, type TeamExecutionRecord } from "@openorc/protocol";
import { moveActor, moveAttempt, moveExecution } from "./team-states.js";

describe("team state steps", () => {
  it("takes only the steps the transition tables allow, and staying put is always allowed", () => {
    const actor = { id: "lead", state: "queued" } as TeamActorRecord;
    moveActor(actor, "starting");
    moveActor(actor, "running");
    moveActor(actor, "running");
    moveActor(actor, "completed");
    expect(() => moveActor(actor, "running")).toThrow("Team member lead cannot move from completed to running.");
    expect(actor.state).toBe("completed");
    moveActor(actor, "queued");
    expect(actor.state).toBe("queued");
  });

  it("keeps a settled turn settled and a finished execution finished", () => {
    const attempt = { id: "turn", state: "closed" } as TeamAttemptRecord;
    for (const to of ["starting", "running", "attention", "cancelled"] as const) expect(() => moveAttempt(attempt, to)).toThrow(/cannot move from closed/);
    const execution = { id: "run", state: "completed" } as TeamExecutionRecord;
    for (const to of ["active", "attention", "stopping", "stopped"] as const) expect(() => moveExecution(execution, to)).toThrow(/cannot move from completed/);
  });

  it("lists every state in each table", () => {
    for (const table of [TEAM_ACTOR_TRANSITIONS, TEAM_ATTEMPT_TRANSITIONS, TEAM_EXECUTION_TRANSITIONS])
      for (const targets of Object.values(table)) for (const target of targets) expect(Object.keys(table)).toContain(target);
  });
});
