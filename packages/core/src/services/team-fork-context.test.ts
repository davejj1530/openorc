import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Db, LedgerWriter, orchestration, projects, runs, tasks, teamContextParts, teamContexts, teamOrigins, teamRuntime, threads } from "@openorc/db";
import { DEFAULT_TEAM_LIMITS, MAX_TEAM_CONTEXT_BYTES, type TeamActorRecord, type TeamAttemptRecord, type TeamExecutionRecord, type TeamMailboxMessage } from "@openorc/protocol";
import { buildTeamContextSeed, buildTeamForkSeed } from "./team-context.js";

const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
const settings = { agent: "codex" as const, model: "fixture", effort: null, fastMode: false };
function actor(id = "lead", taskId: string | null = null): TeamActorRecord {
  return {
    id,
    memberKey: taskId ? "worker" : "lead",
    taskId,
    parentId: taskId ? "lead" : null,
    requestKey: taskId ? id : null,
    requestHash: taskId ? id : null,
    dependencies: [],
    input: { title: "Work", spec: taskId ? "Worker instructions only" : "Original source instruction", attachments: ["/original.png"], responsibility: "Work", settings },
    state: "queued",
    retries: 0,
    directionVersion: 6,
    deliveredVersion: 0,
    disposition: null,
    result: null,
    snapshotId: null,
    error: null,
  };
}
function fixture() {
  const db = Db.memory();
  opened.push(db);
  const project = projects.insert(db, { name: "Fork context", rootPath: `/tmp/${randomUUID()}`, defaultBranch: "main", gitRemote: null, settings: {} });
  const team = orchestration.save(db, {
    projectId: project.id,
    expectedRevisionId: null,
    draft: {
      name: "Team",
      limits: DEFAULT_TEAM_LIMITS,
      discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
      members: [
        { key: "lead", name: "Lead", managerKey: null, responsibility: "Coordinate", settings },
        { key: "worker", name: "Worker", managerKey: "lead", responsibility: "Work", settings },
      ],
    },
  });
  const add = () => {
    const thread = threads.insert(db, { projectId: project.id, title: "Context", ...settings, mode: "act", permissionMode: "trusted" });
    const instance = orchestration.createInstance(db, { threadId: thread.id, teamRevisionId: team.revision.id });
    return { thread, instance };
  };
  const source = add();
  const initial = (owner = source): TeamExecutionRecord => ({
    id: randomUUID(),
    threadId: owner.thread.id,
    instanceId: owner.instance.id,
    projectId: project.id,
    state: "active",
    generation: 1,
    revision: 0,
    limits: DEFAULT_TEAM_LIMITS,
    actors: [actor()],
    attempts: [],
    messages: [],
    error: null,
    createdAt: 1,
    updatedAt: 100,
    deadlineAt: 1000,
  });
  const record = initial();
  teamRuntime.create(db, record);
  const turn = (createdAt: number, text: string, actorId = "lead", taskId: string | null = null): TeamAttemptRecord => {
    const run = runs.insert(db, { id: randomUUID(), threadId: taskId ? null : source.thread.id, taskId, ...settings, mode: "act", permissionMode: "trusted" });
    runs.update(db, run.id, { state: "success", resultText: text, externalSessionId: `session-${run.id}`, endedAt: createdAt + 20 });
    return {
      id: randomUUID(),
      actorId,
      runId: run.id,
      generation: 1,
      state: "closed",
      settings,
      configurationVersion: 1,
      directionVersion: 0,
      messageIds: [],
      snapshotId: null,
      error: null,
      createdAt,
      endedAt: createdAt + 20,
    };
  };
  const first = turn(10, "First public result"),
    later = turn(40, "LATER RUN RESULT");
  const message = (sequence: number, body: string, patch: Partial<TeamMailboxMessage> = {}): TeamMailboxMessage => ({
    id: `message-${sequence}`,
    sequence,
    senderId: "user",
    recipientId: "lead",
    kind: "direction",
    body,
    dedupeKey: `key-${sequence}`,
    state: "pending",
    attemptId: null,
    createdAt: sequence,
    deliveredAt: null,
    ...patch,
  });
  record.messages = [
    message(1, "Direction before cutoff", { state: "claimed", attemptId: first.id }),
    message(2, "Accepted live direction", { delivery: "immediate", state: "claimed", attemptId: first.id, attachments: ["/accepted.png"] }),
    message(3, "UNCONFIRMED LIVE DIRECTION", { delivery: "immediate", state: "claimed", attemptId: first.id }),
    message(4, "LATER RESERVED DIRECTION", { state: "claimed", attemptId: later.id }),
    message(5, "Unsent stopped direction", { attachments: ["/pending.png"] }),
    message(6, "CANCELLED DIRECTION", { state: "cancelled", cancelledAt: 100 }),
  ];
  first.messageIds = ["message-1"];
  first.liveDirections = [
    { messageId: "message-2", directionVersion: 1, createdAt: 20, state: "accepted", settledAt: 21, error: null },
    { messageId: "message-3", directionVersion: 2, createdAt: 25, state: "uncertain", settledAt: 26, error: "Lost acknowledgment" },
  ];
  later.messageIds = ["message-4"];
  record.attempts = [first, later];
  record.actors[0]!.result = "MUTABLE LATER ACTOR RESULT";
  record.state = "stopped";
  teamRuntime.update(db, record.id, (state) => {
    state.messages = record.messages.map((message) => ([2, 3, 4].includes(message.sequence) ? { ...message, state: "pending", attemptId: null } : message));
    state.attempts = [{ ...first, state: "running", endedAt: null, liveDirections: [] }];
  });
  teamRuntime.recordPrompt(db, record.id, first.id, "PRIVATE COORDINATOR PROMPT");
  for (const delivery of first.liveDirections) {
    teamRuntime.update(db, record.id, (state) => {
      state.attempts[0]!.liveDirections!.push({ ...delivery, state: "reserved", settledAt: null, error: null });
      const message = state.messages.find((item) => item.id === delivery.messageId)!;
      message.state = "claimed";
      message.attemptId = first.id;
    });
    teamRuntime.update(db, record.id, (state) => {
      state.attempts[0]!.liveDirections![state.attempts[0]!.liveDirections!.length - 1] = delivery;
    });
  }
  teamRuntime.update(db, record.id, (state) => {
    state.attempts[0]!.state = "closed";
    state.attempts[0]!.endedAt = first.endedAt;
    state.attempts.push(later);
    state.messages[3]!.state = "claimed";
    state.messages[3]!.attemptId = later.id;
    state.actors[0]!.result = record.actors[0]!.result;
    state.state = "stopped";
  });
  teamRuntime.recordPrompt(db, record.id, later.id, "PRIVATE COORDINATOR PROMPT");
  const ledger = new LedgerWriter(db, { artifactThresholdBytes: 32 });
  ledger.push({ type: "message.completed", runId: first.runId!, ts: 20, messageId: "public-first", role: "assistant", text: "First published reply" });
  ledger.push({ type: "thinking.completed", runId: first.runId!, ts: 21, messageId: "private", text: "PRIVATE REASONING" });
  ledger.push({ type: "message.completed", runId: first.runId!, ts: 22, messageId: "system", role: "system", text: "PRIVATE SYSTEM MESSAGE" });
  ledger.push({ type: "message.completed", runId: later.runId!, ts: 50, messageId: "public-later", role: "assistant", text: "LATER PUBLISHED REPLY" });
  ledger.close();
  const fork = (owner = source, upToRunId?: string) => {
    const target = add(),
      context = buildTeamForkSeed(db, owner.thread.id, upToRunId);
    teamOrigins.create(db, { instanceId: target.instance.id, sourceThreadId: owner.thread.id, sourceInstanceId: owner.instance.id, ...context });
    return target;
  };
  return { db, source, record, first, later, project, add, initial, turn, fork };
}

describe("independent team fork context", () => {
  it("latest context retains pending stopped direction as history and never resurrects cancelled input", () => {
    const { db, source, later } = fixture();
    const context = buildTeamForkSeed(db, source.thread.id);
    expect(context.sourceRunId).toBe(later.runId);
    expect(context.seed).toContain("Unsent stopped direction");
    expect(context.seed).toContain("/pending.png");
    expect(context.seed).toContain('"state":"pending"');
    expect(context.seed).not.toContain("CANCELLED DIRECTION");
    expect(context.seed).not.toContain("PRIVATE");
  });

  it("bootstraps before any own execution and retains fork-of-fork context after both sources are deleted", () => {
    const { db, source, first, fork, initial } = fixture();
    const child = fork(source, first.runId!);
    const scope = { instanceId: child.instance.id, executionId: null, actorId: "lead" };
    const bootstrap = buildTeamContextSeed(db, scope);
    const checkpoint = teamContexts.create(db, { ...scope, originExecutionId: null, reason: "compact", requestKey: "fork-bootstrap", seed: bootstrap });
    expect(bootstrap).toContain("Accepted live direction");
    expect(JSON.parse(bootstrap).canonical).toEqual([]);
    const own = initial(child);
    own.actors[0]!.input.spec = "Child-only new instructions";
    teamRuntime.create(db, own);
    expect(buildTeamContextSeed(db, scope, own.id)).toContain("Child-only new instructions");
    expect(buildTeamContextSeed(db, scope, own.id)).toContain("Original source instruction");
    expect(() =>
      teamRuntime.update(db, own.id, (state) => {
        state.attempts.push({
          ...first,
          id: randomUUID(),
          runId: null,
          state: "starting",
          endedAt: null,
          messageIds: [],
          liveDirections: [],
          contextCheckpointId: checkpoint.id,
          contextSessionId: `session-${first.runId}`,
        });
      }),
    ).toThrow(/own actor and checkpoint scope/);
    expect(teamRuntime.get(db, own.id)?.attempts).toEqual([]);
    const grandchild = fork(child);
    const grandScope = { instanceId: grandchild.instance.id, executionId: null, actorId: "lead" };
    const before = buildTeamContextSeed(db, grandScope);
    threads.delete(db, source.thread.id);
    threads.delete(db, child.thread.id);
    expect(buildTeamContextSeed(db, grandScope)).toBe(before);
    expect(before).toContain("Original source instruction");
    expect(before).toContain("Child-only new instructions");
    expect(db.stmt("SELECT count(*) AS n FROM team_executions WHERE instance_id=?").get(grandchild.instance.id)).toEqual({ n: 0 });
    expect(db.stmt("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("does not inject the lead's imported history into assignment recovery", () => {
    const { db, first, source, project, fork, initial } = fixture();
    const child = fork(source, first.runId!),
      record = initial(child);
    const task = tasks.insert(db, {
      projectId: project.id,
      threadId: child.thread.id,
      title: "Worker",
      spec: "Worker instructions only",
      priority: "none",
      labels: [],
      workspaceMode: "worktree",
      baseRef: "main",
      parentTaskId: null,
      origin: "agent",
    });
    teamRuntime.create(db, record);
    teamRuntime.update(db, record.id, (state) => {
      state.actors.push(actor("worker-1", task.id));
    });
    const seed = buildTeamContextSeed(db, { instanceId: child.instance.id, executionId: record.id, actorId: "worker-1" });
    expect(seed).toContain("Worker instructions only");
    expect(seed).not.toContain("Original source instruction");
    expect(seed).not.toContain("Accepted live direction");
    expect(JSON.parse(seed).origin).toBeUndefined();
  });

  it("rejects missing, unbound, foreign and worker cutoff runs", () => {
    const { db, source, project, add, initial, turn } = fixture();
    const other = add();
    const foreign = runs.insert(db, { id: randomUUID(), taskId: null, threadId: other.thread.id, ...settings, mode: "act", permissionMode: "trusted" });
    const unbound = runs.insert(db, { id: randomUUID(), taskId: null, threadId: source.thread.id, ...settings, mode: "act", permissionMode: "trusted" });
    const task = tasks.insert(db, {
      projectId: project.id,
      threadId: source.thread.id,
      title: "Worker",
      spec: "Work",
      priority: "none",
      labels: [],
      workspaceMode: "worktree",
      baseRef: "main",
      parentTaskId: null,
      origin: "agent",
    });
    const record = initial(),
      worker = turn(70, "Worker reply", "worker-1", task.id);
    teamRuntime.create(db, record);
    teamRuntime.update(db, record.id, (state) => {
      state.actors.push(actor("worker-1", task.id));
      state.attempts.push(worker);
    });
    for (const id of ["missing", foreign.id, unbound.id, worker.runId!]) expect(() => buildTeamForkSeed(db, source.thread.id, id)).toThrow(/lead run/);
  });

  it("stores oversized inherited history by reference before touching the new instruction", () => {
    const { db, source, add, initial } = fixture();
    const child = add(),
      seed = "é".repeat(MAX_TEAM_CONTEXT_BYTES / 2 - 1000);
    const origin = teamOrigins.create(db, { instanceId: child.instance.id, sourceThreadId: source.thread.id, sourceInstanceId: source.instance.id, sourceRunId: null, seed });
    const record = initial(child);
    record.actors[0]!.input.spec = "x".repeat(4000);
    teamRuntime.create(db, record);
    const built = buildTeamContextSeed(db, { instanceId: child.instance.id, executionId: null, actorId: "lead" });
    expect(Buffer.byteLength(built)).toBeLessThanOrEqual(MAX_TEAM_CONTEXT_BYTES);
    const context = JSON.parse(built) as { storedText: string; origin: { context: { stored: string; bytes: number } }; canonical: { originalInstruction: string }[] };
    expect(context.storedText).toMatch(/team_context/);
    expect(context.canonical[0]!.originalInstruction).toBe("x".repeat(4000));
    expect(teamContextParts.get(db, child.instance.id, context.origin.context.stored)?.content).toBe(JSON.stringify(seed));
    expect(teamContextParts.get(db, source.instance.id, context.origin.context.stored)).toBeNull();
    expect(teamOrigins.get(db, child.instance.id)).toEqual(origin);
    expect(teamContexts.listForInstance(db, child.instance.id)).toEqual([]);
  });
});
