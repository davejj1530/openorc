import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Db, orchestration, projects, tasks, teamRuntime, teamTasks, teamWorkspaces, threads } from "@openorc/db";
import type { TeamActorRecord, TeamExecutionRecord, TeamTaskIntent, TeamWorkspaceRecord } from "@openorc/protocol";
import { teamTaskDependencies } from "./team-tasks.js";

const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
const settings = { agent: "codex" as const, model: "fixture", effort: null, fastMode: false };
const oid = (value: string) => value.repeat(40);
function actor(id: string, memberKey: string, taskId: string | null): TeamActorRecord {
  return {
    id,
    memberKey,
    taskId,
    parentId: taskId ? "lead" : null,
    requestKey: taskId ? id : null,
    requestHash: taskId ? id : null,
    dependencies: [],
    input: { title: id, spec: id, attachments: [], responsibility: id, settings },
    state: "completed",
    retries: 0,
    directionVersion: 0,
    deliveredVersion: 0,
    disposition: null,
    result: "Done",
    snapshotId: null,
    error: null,
  };
}
function fixture() {
  const db = Db.memory();
  opened.push(db);
  const project = projects.insert(db, { name: "Dependency proof", rootPath: "/tmp/task-dependency-proof", defaultBranch: "main", gitRemote: null, settings: {} });
  const thread = threads.insert(db, { projectId: project.id, title: "Dependencies", ...settings, mode: "act", permissionMode: "trusted" });
  const saved = orchestration.save(db, {
    projectId: project.id,
    expectedRevisionId: null,
    draft: {
      name: "Team",
      members: [
        { key: "root", name: "Lead", managerKey: null, responsibility: "Coordinate", settings },
        { key: "worker", name: "Worker", managerKey: "root", responsibility: "Implement", settings },
        { key: "peer", name: "Peer", managerKey: "root", responsibility: "Review", settings },
      ],
      limits: { maxConcurrentAgents: 3, maxAssignments: 12, maxExecutionMinutes: 60, maxAttemptsPerAssignment: 2 },
      discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
    },
  });
  const instance = orchestration.createInstance(db, { threadId: thread.id, teamRevisionId: saved.revision.id });
  const task = (title: string) =>
    tasks.insert(db, { projectId: project.id, threadId: thread.id, title, spec: title, priority: "none", labels: [], workspaceMode: "worktree", baseRef: "main", parentTaskId: null });
  const prerequisite = task("Prerequisite");
  const dependent = task("Dependent");
  const base: Omit<TeamTaskIntent, "taskId" | "memberKey" | "dependencyTaskIds"> = {
    instanceId: instance.id,
    teamRevisionId: saved.revision.id,
    managerKey: "root",
    parentTaskId: null,
    origin: null,
    capture: null,
    createdAt: 1,
  };
  teamTasks.createIntent(db, { ...base, taskId: prerequisite.id, memberKey: "worker", dependencyTaskIds: [] });
  const intent = teamTasks.createIntent(db, { ...base, taskId: dependent.id, memberKey: "peer", dependencyTaskIds: [prerequisite.id] });
  function execution(): TeamExecutionRecord {
    return teamRuntime.create(db, {
      id: randomUUID(),
      instanceId: instance.id,
      threadId: thread.id,
      projectId: project.id,
      state: "active",
      generation: 1,
      revision: 0,
      limits: saved.revision.limits,
      actors: [{ ...actor("lead", "root", null), state: "running" }],
      attempts: [],
      messages: [],
      error: null,
      createdAt: 1,
      updatedAt: 1,
      deadlineAt: 3_600_001,
    });
  }
  const original = execution();
  const previous = teamRuntime.update(db, original.id, (record) => {
    record.actors.push(actor("worker-original", "worker", prerequisite.id));
  }).record;
  function workspace(record: TeamExecutionRecord, actorId: string, sourcePath: string, inputTree: string, outputTree: string | null) {
    const owner = record.actors.find((item) => item.id === actorId)!;
    const value: TeamWorkspaceRecord = {
      id: randomUUID(),
      executionId: record.id,
      actorId,
      taskId: owner.taskId,
      parentActorId: owner.parentId,
      path: `/tmp/team-dependency/${record.id}/${actorId}`,
      source: {
        rootPath: sourcePath,
        headSha: oid("a"),
        branch: "refs/heads/main",
        treeSha: inputTree,
        treeRef: `refs/openorc/input/${randomUUID()}`,
        headRef: `refs/openorc/head/${randomUUID()}`,
        indexSha256: "1".repeat(64),
      },
      state: "ready",
      setupState: "completed",
      preparedTree: inputTree,
      outputTree,
      error: null,
      createdAt: 2,
      updatedAt: 2,
    };
    return teamWorkspaces.save(db, value);
  }
  const oldLead = workspace(previous, "lead", project.rootPath, oid("b"), oid("e"));
  const worker = workspace(previous, "worker-original", oldLead.path, oid("b"), oid("c"));
  function integrate() {
    return teamWorkspaces.savePublication(db, {
      id: randomUUID(),
      executionId: previous.id,
      sourceActorId: worker.actorId,
      targetActorId: "lead",
      outputTree: worker.outputTree!,
      destinationPath: oldLead.path,
      before: { ...oldLead.source, rootPath: oldLead.path },
      afterTree: oid("d"),
      scratchPath: "/tmp/dependency-merge",
      state: "applied",
      entries: [],
      includedActorIds: [worker.actorId],
      error: null,
      createdAt: 3,
      updatedAt: 3,
    });
  }
  function next(inputTree = oldLead.outputTree!) {
    teamRuntime.update(db, previous.id, (record) => {
      record.state = "completed";
      record.actors[0]!.state = "completed";
    });
    const record = execution();
    const lead = workspace(record, "lead", oldLead.path, inputTree, null);
    return { record, lead };
  }
  return { db, instance, prerequisite, intent, previous, oldLead, worker, execution, workspace, integrate, next };
}

describe("saved task prerequisite input", () => {
  it("keeps an unintegrated current sibling as a scheduler dependency", () => {
    const f = fixture();
    expect(teamTaskDependencies(f.db, f.previous, f.previous.actors[0]!, f.intent)).toEqual(["worker-original"]);
    f.integrate();
    expect(teamTaskDependencies(f.db, f.previous, f.previous.actors[0]!, f.intent)).toEqual([]);
  });

  it("rejects a completed historical worker whose output never reached its manager", () => {
    const f = fixture();
    const { record } = f.next();
    expect(() => teamTaskDependencies(f.db, record, record.actors[0]!, f.intent)).toThrow(/no proven accepted output/);
    expect(teamRuntime.get(f.db, record.id)).toEqual(record);
  });

  it("accepts publication plus exact inherited combined output, including a later execution", () => {
    const f = fixture();
    f.integrate();
    const second = f.next();
    expect(teamTaskDependencies(f.db, second.record, second.record.actors[0]!, f.intent)).toEqual([]);
    const secondOutput = teamWorkspaces.save(f.db, { ...second.lead, outputTree: oid("f") });
    teamRuntime.update(f.db, second.record.id, (record) => {
      record.state = "completed";
      record.actors[0]!.state = "completed";
    });
    const third = f.execution();
    f.workspace(third, "lead", secondOutput.path, secondOutput.outputTree!, null);
    expect(teamTaskDependencies(f.db, third, third.actors[0]!, f.intent)).toEqual([]);
  });

  it("does not bypass a newer accepted request that is waiting for manager routing", () => {
    const f = fixture();
    f.integrate();
    const { record } = f.next();
    const admission = teamTasks.createAdmission(f.db, {
      id: randomUUID(),
      instanceId: f.instance.id,
      taskId: f.prerequisite.id,
      requestKey: "prerequisite-followup",
      payloadHash: "a".repeat(64),
      kind: "start",
      input: { title: "Follow-up", spec: "Finish prerequisite feedback", attachments: [] },
      reviewBatchId: null,
      sourceAdmissionId: null,
      source: { executionId: f.previous.id, actorId: "worker-original", snapshotId: null },
      createdAt: 4,
    });
    teamTasks.appendRoute(f.db, { admissionId: admission.id, sequence: 1, executionId: record.id, actorId: "lead", role: "manager", messageId: null, createdAt: 5 });
    expect(() => teamTaskDependencies(f.db, record, record.actors[0]!, f.intent)).toThrow(/unfinished accepted work/);
  });
});
