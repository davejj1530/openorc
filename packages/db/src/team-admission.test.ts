import { afterEach, expect, it } from "vitest";
import { Db } from "./database.js";
import { orchestration } from "./orchestration.js";
import { projects, threads } from "./repos.js";
import { teamRuntime } from "./team-runtime.js";
import type { TeamDraft } from "@openorc/protocol";

const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
const draft: TeamDraft = {
  name: "Delivery",
  members: [{ key: "lead", name: "Lead", managerKey: null, responsibility: "Coordinate", settings: { agent: "codex", model: "fixture", effort: "high", fastMode: false } }],
  limits: { maxConcurrentAgents: 2, maxAssignments: 12, maxExecutionMinutes: 60, maxAttemptsPerAssignment: 2 },
};
function fixture() {
  const db = Db.memory();
  opened.push(db);
  const project = projects.insert(db, { name: "App", rootPath: "/tmp/team-admission", gitRemote: null, defaultBranch: "main", settings: {} });
  const saved = orchestration.save(db, { projectId: project.id, expectedRevisionId: null, draft });
  const add = () => threads.insert(db, { projectId: project.id, title: "New team task", agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted" });
  return { db, project, saved, add };
}

it("rolls back composed thread and team admission even after inner repository transactions succeed", () => {
  const { db, saved, add } = fixture();
  expect(() =>
    db.transaction(() => {
      const thread = add();
      orchestration.createInstance(db, { threadId: thread.id, teamRevisionId: saved.revision.id });
      throw new Error("Admission changed before its execution was recorded");
    }),
  ).toThrow(/Admission changed/);
  expect(threads.list(db)).toEqual([]);
  expect(db.stmt("SELECT * FROM orchestration_team_instances").all()).toEqual([]);
  const admitted = db.transaction(() => {
    const thread = add();
    return orchestration.createInstance(db, { threadId: thread.id, teamRevisionId: saved.revision.id });
  });
  expect(orchestration.getInstance(db, admitted.threadId)).toEqual(admitted);
});

it("can recover from an inner transaction failure while preserving the outer transaction", () => {
  const { db, add } = fixture();
  const kept = db.transaction(() => {
    const first = add();
    expect(() =>
      db.transaction(() => {
        add();
        throw new Error("inner failure");
      }),
    ).toThrow("inner failure");
    const last = add();
    return [first.id, last.id];
  });
  expect(
    threads
      .list(db)
      .map((thread) => thread.id)
      .sort(),
  ).toEqual(kept.sort());
});

it("changes idle lead settings with optimistic concurrency without changing the roster or another instance", () => {
  const { db, saved, add } = fixture();
  const instance = orchestration.createInstance(db, { threadId: add().id, teamRevisionId: saved.revision.id });
  const other = orchestration.createInstance(db, { threadId: add().id, teamRevisionId: saved.revision.id });
  const updated = orchestration.updateLeadOverrides(db, { threadId: instance.threadId, expectedConfigurationVersion: 1, leadOverrides: { effort: "low", fastMode: true } });
  expect(updated).toEqual({ ...instance, configurationVersion: 2, leadOverrides: { effort: "low", fastMode: true } });
  expect(orchestration.updateLeadOverrides(db, { threadId: instance.threadId, expectedConfigurationVersion: 2, leadOverrides: updated.leadOverrides })).toEqual(updated);
  expect(() => orchestration.updateLeadOverrides(db, { threadId: instance.threadId, expectedConfigurationVersion: 1, leadOverrides: {} })).toThrow(/another window/);
  expect(orchestration.getInstance(db, other.threadId)).toEqual(other);
  expect(orchestration.getRevision(db, saved.revision.id)).toEqual(saved.revision);
});

it("versions future lead settings during recovery without rewriting captured assignment input", () => {
  const { db, project, saved, add } = fixture();
  const instance = orchestration.createInstance(db, { threadId: add().id, teamRevisionId: saved.revision.id });
  teamRuntime.create(db, {
    id: "execution",
    instanceId: instance.id,
    projectId: project.id,
    threadId: instance.threadId,
    state: "active",
    generation: 1,
    revision: 0,
    limits: draft.limits,
    actors: [
      {
        id: "lead",
        memberKey: "lead",
        taskId: null,
        parentId: null,
        requestKey: null,
        requestHash: null,
        dependencies: [],
        input: { title: "Work", spec: "Do the work", attachments: [], responsibility: "Coordinate", settings: draft.members[0]!.settings },
        state: "queued",
        retries: 0,
        directionVersion: 0,
        deliveredVersion: 0,
        disposition: null,
        result: null,
        snapshotId: null,
        error: null,
      },
    ],
    attempts: [],
    messages: [],
    error: null,
    createdAt: 1,
    updatedAt: 1,
    deadlineAt: 1000,
  });
  teamRuntime.update(db, "execution", (record) => {
    record.state = "attention";
    record.error = "Interrupted";
    record.actors[0]!.state = "attention";
  });
  const before = teamRuntime.get(db, "execution");
  expect(orchestration.updateLeadOverrides(db, { threadId: instance.threadId, expectedConfigurationVersion: 1, leadOverrides: { fastMode: true } })).toMatchObject({
    configurationVersion: 2,
    leadOverrides: { fastMode: true },
  });
  expect(teamRuntime.get(db, "execution")).toEqual(before);
  expect(orchestration.getRevision(db, saved.revision.id)).toEqual(saved.revision);
});
