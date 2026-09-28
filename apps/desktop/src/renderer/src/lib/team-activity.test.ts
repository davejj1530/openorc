import { describe, expect, it } from "vitest";
import type { TeamActorView, TeamExecutionView } from "@openorc/protocol";
import { hasOpenTeamExecution, teamActivityGroups, teamMemberActivity, teamChatDeliveryStatus, teamDirectionStatus, teamFileList, teamRunBlocks } from "./team-activity";
import type { Block } from "./transcript";

function actor(id: string, createdAt: number, parentId: string | null = "lead"): TeamActorView {
  const runs = (
    parentId
      ? [{ id: `run-${id}`, startedAt: createdAt + 1 }]
      : [
          { id: "lead-1", startedAt: 100 },
          { id: "lead-2", startedAt: 300 },
        ]
  ).map((run) => ({ ...run, turnId: `turn-${run.id}`, turn: 0 }));
  return {
    id,
    memberKey: id,
    taskId: parentId ? `task-${id}` : null,
    parentId,
    title: `Work for ${id}`,
    createdAt,
    state: "completed",
    settings: { agent: "codex", model: "same-model", effort: "medium", fastMode: false },
    runs,
    runIds: runs.map((run) => run.id),
    activeRunId: null,
    error: null,
    result: "Done",
    retry: { allowed: false, reason: "Completed" },
    workspace: null,
  };
}
function execution(): TeamExecutionView {
  return {
    id: "execution",
    state: "active",
    generation: 1,
    createdAt: 100,
    updatedAt: 500,
    error: null,
    activity: "working",
    initialPrompt: { text: "Build it", attachments: [], createdAt: 100 },
    publications: [],
    userDirections: [
      { id: "direction-1", text: "Review it", createdAt: 250 },
      { id: "direction-2", text: "One more thing", createdAt: 450 },
    ],
    actors: [actor("lead", 100, null), actor("worker-a", 150), actor("worker-b", 200), actor("reviewer", 350)],
  };
}
const summary = (groups: ReturnType<typeof teamActivityGroups>) => groups.map((group) => ({ id: group.id, actors: group.actors.map((member) => member.id) }));
const lead = (data: TeamExecutionView) => data.actors.find((item) => item.parentId === null)!;

describe("team conversation replay", () => {
  it("shows a turn's own activity without its provider inputs", () => {
    const blocks: Block[] = [
      { id: "internal", kind: "message", role: "user", text: "Private coordinator prompt", streaming: false },
      { id: "before", kind: "message", role: "assistant", text: "Before direction", streaming: false },
      { id: "team-direction:direction-1", kind: "message", role: "user", text: "Shown once, as its own feed item", streaming: false },
      { id: "tool", kind: "tool", name: "exec", input: {}, done: true },
      { id: "after", kind: "message", role: "assistant", text: "After direction", streaming: false },
    ];
    expect(teamRunBlocks(blocks).map((block) => block.id)).toEqual(["before", "tool", "after"]);
    expect(teamRunBlocks([])).toEqual([]);
  });

  it("distinguishes native acknowledgement from uncertain live dispatch and later successful recovery", () => {
    const direction = { ...execution().userDirections[0]!, state: "claimed" as const };
    const active = { executionState: "active", leadState: "running" } as const;
    expect(teamDirectionStatus({ ...direction, live: { runId: "lead-1", state: "reserved" } }, "Lead", active)).toBe("Sending…");
    expect(teamDirectionStatus({ ...direction, live: { runId: "lead-1", state: "accepted" } }, "Lead", active)).toBe("Sent");
    const uncertain = { ...direction, live: { runId: "lead-1", state: "uncertain" as const } };
    expect(teamDirectionStatus(uncertain, "Lead", { executionState: "attention", leadState: "attention" })).toBe("Couldn’t confirm delivery · review before retrying");
    expect(teamDirectionStatus(uncertain, "Lead", { executionState: "stopped", leadState: "cancelled" })).toBe("Couldn’t confirm delivery · review before retrying");
    expect(teamDirectionStatus({ ...uncertain, state: "delivered" }, "Lead", active)).toBe("Sent");
  });

  it("keeps canonical direction images and delivery state after reload without inferring receipt for old history", () => {
    const data = execution();
    data.userDirections[0] = { ...data.userDirections[0]!, attachments: ["/images/design.png"], state: "pending" };
    const replay: TeamExecutionView = JSON.parse(JSON.stringify(data));
    const directions = replay.userDirections;
    const context = { executionState: "active", leadState: "running" } as const;
    expect(directions[0]).toEqual(data.userDirections[0]);
    expect(teamDirectionStatus(directions[0]!, "Design lead", context)).toBe("Queued for next turn");
    expect(teamDirectionStatus({ ...directions[0]!, state: "claimed" }, "Design lead", context)).toBe("Sending…");
    expect(teamDirectionStatus({ ...directions[0]!, state: "delivered" }, "Design lead", context)).toBe("Sent");
    expect(teamDirectionStatus(directions[1]!, "Design lead", context)).toBeNull();
  });

  it("distinguishes stopped or failed delivery from a confirmed receipt", () => {
    const direction = execution().userDirections[0]!;
    for (const executionState of ["stopped", "stopping"] as const) {
      const context = { executionState, leadState: "cancelled" } as const;
      expect(teamDirectionStatus({ ...direction, state: "pending" }, "Lead", context)).toBe("Couldn’t send · team stopped");
      expect(teamDirectionStatus({ ...direction, state: "claimed" }, "Lead", context)).toBe("Couldn’t send · team stopped");
      expect(teamDirectionStatus({ ...direction, state: "delivered" }, "Lead", context)).toBe("Sent");
      expect(teamDirectionStatus(direction, "Lead", context)).toBeNull();
    }
    const failed = { executionState: "attention", leadState: "attention" } as const;
    expect(teamDirectionStatus({ ...direction, state: "pending" }, "Lead", failed)).toBe("Couldn’t send · Lead needs attention");
    expect(teamDirectionStatus({ ...direction, state: "claimed" }, "Lead", failed)).toBe("Couldn’t send · Lead needs attention");
    expect(teamDirectionStatus({ ...direction, state: "delivered" }, "Lead", failed)).toBe("Sent");
    // A worker's recovery must not mislabel a healthy lead's direction.
    expect(teamDirectionStatus({ ...direction, state: "claimed" }, "Lead", { executionState: "attention", leadState: "running" })).toBe("Sending…");
  });

  it("keeps cancelled direction text and images in replay without implying delivery or recovery", () => {
    const data = execution();
    data.userDirections[0] = { ...data.userDirections[0]!, attachments: ["/images/cancelled-design.png"], state: "cancelled", cancel: { allowed: false, reason: "Already cancelled" } };
    const replay: TeamExecutionView = JSON.parse(JSON.stringify(data));
    const direction = replay.userDirections[0]!;
    expect(direction).toEqual(data.userDirections[0]);
    for (const executionState of ["active", "attention", "stopping", "stopped", "completed"] as const) {
      expect(teamDirectionStatus(direction, "Lead", { executionState, leadState: "attention" })).toBe("Cancelled");
    }
    // An old projection has no cancellation capability to infer from a pending label.
    expect(data.userDirections[1]!.cancel).toBeUndefined();
  });

  it("blocks team organization for every unfinished execution including attention and stopping", () => {
    expect(hasOpenTeamExecution([])).toBe(false);
    expect(hasOpenTeamExecution([{ state: "completed" }, { state: "stopped" }])).toBe(false);
    for (const state of ["active", "attention", "stopping"] as const) {
      expect(hasOpenTeamExecution([{ state }, { state: "completed" }])).toBe(true);
    }
  });

  it("keeps a manager's assignments in one group while it has not run yet", () => {
    const data = execution();
    const manager = actor("manager", 150);
    manager.runIds = [];
    manager.runs = [];
    const workers = [actor("worker-a", 180, manager.id), actor("worker-b", 200, manager.id)];
    data.actors = [lead(data), manager, ...workers];
    const groups = teamActivityGroups(data, manager);
    expect(groups).toEqual([{ id: "pending-manager", runId: null, actors: workers }]);
  });

  it("keeps descendants with the manager turn that delegated them, once each on replay", () => {
    const data = execution();
    const manager = actor("manager", 150);
    manager.runs = [
      { id: "manager-1", startedAt: 160 },
      { id: "manager-2", startedAt: 400 },
    ].map((run) => ({ ...run, turnId: `turn-${run.id}`, turn: 0 }));
    manager.runIds = manager.runs.map((run) => run.id);
    manager.dispatchedBy = "turn-lead-1";
    const otherManager = { ...actor("other-manager", 350), dispatchedBy: "turn-lead-2" };
    // A saved task reused later keeps its old creation time; the delegating turn still places it.
    const firstWorker = { ...actor("assignment-a", 900, manager.id), dispatchedBy: "turn-manager-1" };
    const repeatedWorker = { ...actor("assignment-b", 410, manager.id), dispatchedBy: "turn-manager-2" };
    // The same saved member can receive another durable assignment. Identity is
    // the actor, never the model or saved member key.
    firstWorker.memberKey = repeatedWorker.memberKey = "shared-worker";
    const otherWorker = { ...actor("assignment-c", 420, otherManager.id), dispatchedBy: "turn-run-other-manager" };
    data.actors = [lead(data), manager, firstWorker, otherManager, repeatedWorker, otherWorker];
    expect(summary(teamActivityGroups(data, lead(data)))).toEqual([
      { id: "lead-1", actors: [manager.id] },
      { id: "lead-2", actors: [otherManager.id] },
    ]);
    expect(summary(teamActivityGroups(data, manager))).toEqual([
      { id: "manager-1", actors: [firstWorker.id] },
      { id: "manager-2", actors: [repeatedWorker.id] },
    ]);
    expect(summary(teamActivityGroups(data, otherManager))).toEqual([{ id: "run-other-manager", actors: [otherWorker.id] }]);
    const walk = (value: TeamExecutionView) => {
      const ids: string[] = [];
      const visit = (parent: TeamActorView) => {
        for (const child of teamActivityGroups(value, parent).flatMap((group) => group.actors)) {
          ids.push(child.id);
          visit(child);
        }
      };
      visit(lead(value));
      return ids;
    };
    expect(walk(data)).toEqual([manager.id, firstWorker.id, repeatedWorker.id, otherManager.id, otherWorker.id]);
    expect(new Set(walk(data)).size).toBe(data.actors.length - 1);
    const replay: TeamExecutionView = JSON.parse(JSON.stringify(data));
    replay.actors.reverse();
    expect(walk(replay)).toEqual(walk(data));
  });

  it("keeps assignments visible in an older cached projection that does not say which turn delegated them", () => {
    const data = execution();
    const manager = actor("manager", 150);
    const worker = actor("worker", 180, manager.id);
    data.actors = [lead(data), manager, worker];
    const older: TeamExecutionView = JSON.parse(JSON.stringify(data, (key, value) => (key === "runs" ? undefined : value)));
    expect(teamActivityGroups(older, lead(older)).map((group) => ({ runId: group.runId, actors: group.actors.map((item) => item.id) }))).toEqual([
      { runId: "lead-1", actors: [] },
      { runId: "lead-2", actors: [manager.id] },
    ]);
    expect(teamActivityGroups(older, older.actors[1]!).flatMap((group) => group.actors.map((item) => item.id))).toEqual([worker.id]);
  });

  it("keeps queued descendants visible independently of their manager's provider history", () => {
    const data = execution();
    const manager = actor("manager", 150);
    manager.runs = [];
    manager.runIds = [];
    manager.state = "waiting";
    const worker = actor("worker", 180, manager.id);
    worker.state = "attention";
    data.actors = [lead(data), manager, worker];
    expect(teamActivityGroups(data, lead(data)).flatMap((group) => group.actors)).toEqual([manager]);
    expect(teamActivityGroups(data, manager)).toEqual([{ id: "pending-manager", runId: null, actors: [worker] }]);
    expect(teamActivityGroups(data, worker).flatMap((group) => group.actors)).toEqual([]);
  });
});

describe("team chat", () => {
  it("summarizes per-addressee delivery from state and live delivery", () => {
    expect(teamChatDeliveryStatus({ actorId: "a", name: "A", state: "delivered" })).toBe("Sent");
    expect(teamChatDeliveryStatus({ actorId: "a", name: "A", state: "pending" })).toBe("Queued for next turn");
    expect(teamChatDeliveryStatus({ actorId: "a", name: "A", state: "claimed" })).toBe("Sending…");
    expect(teamChatDeliveryStatus({ actorId: "a", name: "A", state: "claimed", live: "reserved" })).toBe("Sending…");
    expect(teamChatDeliveryStatus({ actorId: "a", name: "A", state: "claimed", live: "accepted" })).toBe("Sent");
    expect(teamChatDeliveryStatus({ actorId: "a", name: "A", state: "claimed", live: "uncertain" })).toBe("Couldn’t confirm delivery · review before retrying");
    expect(teamChatDeliveryStatus({ actorId: "a", name: "A", state: "cancelled", live: "accepted" })).toBe("Cancelled");
  });
  it("lists changed and held files with a count past the limit", () => {
    expect(teamFileList([])).toBe("");
    expect(teamFileList(["src/app.ts", "lib/util.ts"])).toBe("src/app.ts, lib/util.ts");
    const many = Array.from({ length: 10 }, (_, index) => `file-${index}.ts`);
    expect(teamFileList(many)).toBe(`${many.slice(0, 8).join(", ")} and 2 more`);
    expect(teamFileList(many, 2)).toBe("file-0.ts, file-1.ts and 8 more");
    expect(teamFileList(many.slice(0, 8))).toBe(many.slice(0, 8).join(", "));
  });
});

describe("current member activity", () => {
  it("prioritizes approvals and scheduler waits over old transcript activity", () => {
    const member = { ...actor("one", 1), state: "running" as const };
    const blocks: Block[] = [{ id: "tool", kind: "tool", name: "mcp.run_tests", input: {}, done: false }];
    expect(teamMemberActivity(member, blocks)).toBe("Running run tests");
    blocks.push({ id: "approval", kind: "approval", approvalId: "approval", approvalKind: "command", input: {} });
    expect(teamMemberActivity(member, blocks)).toBe("Needs your input");
    expect(teamMemberActivity({ ...member, state: "queued", waitReason: "Waiting for Codex capacity" }, blocks)).toBe("Waiting for Codex capacity");
    expect(teamMemberActivity({ ...member, state: "waiting" }, blocks)).toBe("Ready for a message");
    expect(teamMemberActivity({ ...member, state: "attention" }, blocks)).toBe("Needs attention");
    expect(teamMemberActivity({ ...member, state: "completed" }, blocks)).toBe("Finished");
  });
  it("distinguishes current thinking, writing, and completed tools", () => {
    const member = { ...actor("one", 1), state: "running" as const };
    expect(teamMemberActivity(member, [{ id: "thought", kind: "thinking", text: "", startedAt: 1, endedAt: null }])).toBe("Thinking…");
    expect(teamMemberActivity(member, [{ id: "reply", kind: "message", role: "assistant", text: "", streaming: true }])).toBe("Writing…");
    expect(teamMemberActivity(member, [{ id: "tool", kind: "tool", name: "exec", input: {}, done: true }])).toBe("Working…");
  });
});
