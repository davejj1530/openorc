import { afterEach, describe, expect, it, vi } from "vitest";
import type { TeamExecutionView } from "@openorc/protocol";
import { actorContextCheckpoints, beginTeamContextRequest, finishTeamContextRequest, readTeamContextRequest, teamContextHistory, type TeamContextCheckpoint } from "./team-context";

afterEach(() => vi.unstubAllGlobals());

describe("durable team context actions", () => {
  function storage() {
    const values = new Map<string, string>();
    const fixture = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: vi.fn((key: string, value: string) => {
        values.set(key, value);
      }),
    };
    vi.stubGlobal("localStorage", fixture);
    return fixture;
  }

  it("fails before starting an unrecorded action, and keeps an accepted key if clearing storage fails", () => {
    const fixture = storage();
    const key = "context";
    const original = beginTeamContextRequest(key);
    fixture.setItem.mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    expect(() => beginTeamContextRequest(key)).toThrow("Could not save this context request");
    expect(finishTeamContextRequest(key, original)).toBe(false);
    expect(readTeamContextRequest(key)).toBe(original);
  });

  it("confirms a locally pending identity even if another view has already cleared it", () => {
    storage();
    const original = beginTeamContextRequest("context");
    finishTeamContextRequest("context", original);
    expect(beginTeamContextRequest("context", original)).toBe(original);
    finishTeamContextRequest("context", original);
    const newer = beginTeamContextRequest("context");
    expect(beginTeamContextRequest("context", original)).toBe(original);
    expect(finishTeamContextRequest("context", original)).toBe(true);
    expect(readTeamContextRequest("context")).toBe(newer);
  });

  it("ignores malformed local request envelopes", () => {
    const fixture = storage();
    for (const value of ["null", "broken json", JSON.stringify({ requestKey: {} }), JSON.stringify({ requestKey: "" }), JSON.stringify({ requestKey: "x".repeat(201) })]) {
      fixture.setItem("openorc.draft.context", value);
      expect(readTeamContextRequest("context")).toBeNull();
      expect(beginTeamContextRequest("context")).toMatch(/^[\da-f-]{36}$/);
    }
  });
});

describe("context history attribution", () => {
  const checkpoints: TeamContextCheckpoint[] = [
    { id: "second-lead", actorId: "lead", executionId: "second", reason: "fresh_retry", createdAt: 350 },
    { id: "compact", actorId: "lead", executionId: null, reason: "compact", createdAt: 200 },
    { id: "worker", actorId: "worker", executionId: "first", reason: "fresh_retry", createdAt: 170 },
    { id: "first-lead", actorId: "lead", executionId: "first", reason: "fresh_retry", createdAt: 150 },
  ];

  it("keeps lead recovery attached to its original execution and descendants to their actual actor", () => {
    expect(actorContextCheckpoints(checkpoints, "first", "lead").map((item) => item.id)).toEqual(["first-lead"]);
    expect(actorContextCheckpoints(checkpoints, "second", "lead").map((item) => item.id)).toEqual(["second-lead"]);
    expect(actorContextCheckpoints(checkpoints, "first", "worker").map((item) => item.id)).toEqual(["worker"]);
    expect(actorContextCheckpoints(checkpoints, "second", "worker")).toEqual([]);
  });

  it("places compaction between executions exactly once without duplicating fresh recovery notices", () => {
    const execution = (id: string, createdAt: number): TeamExecutionView => ({
      id,
      createdAt,
      updatedAt: createdAt,
      state: "completed",
      generation: 1,
      error: null,
      activity: "idle",
      initialPrompt: { text: id, attachments: [], createdAt },
      userDirections: [],
      actors: [],
      publications: [],
    });
    const executions = [execution("first", 100), execution("second", 200)];
    const history = teamContextHistory(executions, checkpoints);
    expect(
      history.map((item) => {
        switch (item.kind) {
          case "execution":
            return item.execution.id;
          case "checkpoint":
            return item.checkpoint.id;
          case "restore":
            return item.restore.id;
          case "move":
            return item.move.id;
        }
      }),
    ).toEqual(["first", "compact", "second"]);
    expect(teamContextHistory(executions).map((item) => item.kind)).toEqual(["execution", "execution"]);
    expect(teamContextHistory(JSON.parse(JSON.stringify(executions)), JSON.parse(JSON.stringify(checkpoints)))).toEqual(history);
  });

  it("places retained workspace restores before later work without inventing compact notices", () => {
    const execution: TeamExecutionView = {
      id: "after-restore",
      createdAt: 300,
      updatedAt: 300,
      state: "completed",
      generation: 1,
      error: null,
      activity: "idle",
      initialPrompt: { text: "Continue", attachments: [], createdAt: 300 },
      userDirections: [],
      actors: [],
      publications: [],
    };
    const restores = [{ id: "restore-1", checkpointId: "original-turn", sourceRunId: "original-run", createdAt: 300 }];
    const history = teamContextHistory([execution], [], restores);
    expect(history.map((item) => item.kind)).toEqual(["restore", "execution"]);
    expect(history.filter((item) => item.kind === "restore")).toEqual([{ kind: "restore", restore: restores[0] }]);
    expect(teamContextHistory(JSON.parse(JSON.stringify([execution])), [], JSON.parse(JSON.stringify(restores)))).toEqual(history);
  });

  it("places moves once before later executions and keeps their real destination across reload", () => {
    const execution: TeamExecutionView = {
      id: "local-work",
      createdAt: 300,
      updatedAt: 300,
      state: "completed",
      generation: 1,
      error: null,
      activity: "idle",
      initialPrompt: { text: "Continue", attachments: [], createdAt: 300 },
      userDirections: [],
      actors: [],
      publications: [],
    };
    const moves = [
      { id: "into-checkout", to: "current" as const, createdAt: 300 },
      { id: "back-to-worktree", to: "worktree" as const, createdAt: 400 },
    ];
    const history = teamContextHistory([execution], [], [], moves);
    expect(history.map((item) => item.kind)).toEqual(["move", "execution", "move"]);
    expect(history.filter((item) => item.kind === "move").map((item) => item.move)).toEqual(moves);
    expect(teamContextHistory(JSON.parse(JSON.stringify([execution])), [], [], JSON.parse(JSON.stringify(moves)))).toEqual(history);
  });
});
