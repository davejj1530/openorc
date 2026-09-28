import { insertLegacyRun } from "./fixtures/legacy-run.js";
import { LEGACY_TEAM_PROMPT, legacyTeamRuntime } from "./fixtures/legacy-team-journal.js";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { TeamActorRecord, TeamDraft, TeamExecutionRecord, TeamPublicationRecord, TeamTreeCapture, TeamWorkspaceRecord } from "@openorc/protocol";
import { Db } from "./database.js";
import { orchestration } from "./orchestration.js";
import { projects, runs, tasks, threads } from "./repos.js";
import { migrations } from "./schema.js";
import { teamRuntime } from "./team-runtime.js";
import { teamWorkspaces } from "./team-workspaces.js";

const opened = new Set<Db>();
const folders: string[] = [];
afterEach(() => {
  for (const db of opened) db.close();
  opened.clear();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
function close(db: Db) {
  db.close();
  opened.delete(db);
}
const settings = { agent: "codex" as const, model: "fixture-model", effort: "high", fastMode: false };
const oid = (character: string) => character.repeat(40);

function actor(id: string, taskId: string | null): TeamActorRecord {
  return {
    id,
    memberKey: taskId ? "worker" : "coordinator",
    taskId,
    parentId: taskId ? "lead" : null,
    requestKey: taskId ? "build-request" : null,
    requestHash: taskId ? "build-hash" : null,
    dependencies: [],
    input: { title: "Retained work", spec: "Preserve source and staged changes", attachments: [], responsibility: "Implement", settings },
    state: "queued",
    retries: 0,
    directionVersion: 0,
    deliveredVersion: 0,
    disposition: null,
    result: null,
    snapshotId: null,
    error: null,
  };
}

function capture(rootPath: string): TeamTreeCapture {
  return { rootPath, headSha: oid("a"), branch: "refs/heads/main", treeSha: oid("b"), treeRef: "refs/openorc/team/input/tree", headRef: "refs/openorc/team/input/head", indexSha256: "c".repeat(64) };
}

describe("team workspace migration and retention", () => {
  it("upgrades fixed version 9 without losing runtime history and reopens output and publication recovery journals", () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), "team-workspaces-migration-"));
    folders.push(folder);
    const file = path.join(folder, "ledger.sqlite");
    const raw = new DatabaseSync(file);
    for (const migration of migrations.slice(0, 9)) typeof migration === "string" ? raw.exec(migration) : migration(raw);
    raw.exec("PRAGMA user_version = 9");
    const oldDb = new Db(raw);
    opened.add(oldDb);
    const project = projects.insert(oldDb, { name: "Migration fixture", rootPath: path.join(folder, "repository"), gitRemote: null, defaultBranch: "main", settings: {} });
    const thread = threads.insert(oldDb, { projectId: project.id, title: "Existing team", ...settings, mode: "act", permissionMode: "trusted" });
    const draft: TeamDraft = {
      name: "Retained team",
      limits: { maxConcurrentAgents: 2, maxAssignments: 12, maxExecutionMinutes: 60, maxAttemptsPerAssignment: 2 },
      members: [
        { key: "coordinator", name: "Lead", managerKey: null, responsibility: "Coordinate", settings },
        { key: "worker", name: "Worker", managerKey: "coordinator", responsibility: "Implement", settings },
      ],
    };
    const team = orchestration.save(oldDb, { projectId: project.id, expectedRevisionId: null, draft });
    const instance = orchestration.createInstance(oldDb, { threadId: thread.id, teamRevisionId: team.revision.id });
    const record: TeamExecutionRecord = {
      id: randomUUID(),
      instanceId: instance.id,
      projectId: project.id,
      threadId: thread.id,
      state: "active",
      generation: 1,
      revision: 0,
      limits: draft.limits,
      actors: [actor("lead", null)],
      attempts: [],
      messages: [],
      error: null,
      createdAt: 1_000,
      updatedAt: 1_000,
      deadlineAt: 3_601_000,
    };
    legacyTeamRuntime.create(oldDb, record);
    const run = insertLegacyRun(oldDb, { id: "retained-lead-run", taskId: null, threadId: thread.id, ...settings, mode: "act", permissionMode: "trusted" });
    const saved = legacyTeamRuntime.update(oldDb, record.id, (execution) => {
      const task = tasks.insert(oldDb, {
        projectId: project.id,
        threadId: thread.id,
        title: "Child work",
        spec: "Retain result",
        priority: "none",
        labels: [],
        workspaceMode: "worktree",
        baseRef: "main",
        parentTaskId: null,
        origin: "agent",
      });
      execution.actors.push(actor("worker-1", task.id));
      execution.actors[0]!.directionVersion = 1;
      execution.attempts.push({
        id: "retained-attempt",
        actorId: "lead",
        runId: run.id,
        generation: 1,
        state: "closed",
        settings,
        configurationVersion: 1,
        directionVersion: 0,
        messageIds: [],
        snapshotId: null,
        error: null,
        createdAt: 1_000,
        endedAt: 2_000,
      });
      execution.messages.push({
        id: "retained-message",
        sequence: 1,
        senderId: "user",
        recipientId: "lead",
        kind: "direction",
        body: "Keep my staged changes",
        dedupeKey: "retained-direction",
        state: "pending",
        attemptId: null,
        createdAt: 2_001,
        deliveredAt: null,
      });
    }).record;
    close(oldDb);

    const migrated = Db.open(file);
    opened.add(migrated);
    expect(migrated.version).toBe(migrations.length);
    expect(teamRuntime.get(migrated, record.id)).toEqual(saved);
    expect(teamRuntime.prompt(migrated, record.id, "retained-attempt")).toBe(LEGACY_TEAM_PROMPT);
    expect(orchestration.get(migrated, team.team.id)).toEqual(team);
    expect(orchestration.getInstance(migrated, thread.id)).toEqual(instance);
    expect(runs.get(migrated, run.id)).toEqual({ ...run, workingDirectory: null, commentTurnId: null });
    expect(teamRuntime.binding(migrated, run.id)?.executionId).toBe(record.id);
    expect(teamWorkspaces.list(migrated)).toEqual([]);
    expect(teamWorkspaces.publications(migrated)).toEqual([]);

    const leadPath = path.join(folder, "lead-integration");
    const retained: TeamWorkspaceRecord[] = saved.actors.map((item) => ({
      id: `workspace-${item.id}`,
      executionId: record.id,
      actorId: item.id,
      taskId: item.taskId,
      parentActorId: item.parentId,
      path: item.id === "lead" ? leadPath : path.join(folder, "worker-1"),
      source: capture(item.id === "lead" ? project.rootPath : leadPath),
      state: "ready",
      setupState: "completed",
      preparedTree: oid("b"),
      outputTree: item.id === "lead" ? null : oid("d"),
      error: null,
      createdAt: 3_000,
      updatedAt: 4_000,
    }));
    for (const workspace of retained) teamWorkspaces.save(migrated, workspace);
    const completed = teamRuntime.update(migrated, record.id, (execution) => {
      execution.actors[1]!.state = "completed";
      execution.actors[1]!.result = "Implemented without changing user staging";
    }).record;
    const filename = "résultat\twith\nnewlines.txt";
    const receipt: TeamPublicationRecord = {
      id: "interrupted-publication",
      executionId: record.id,
      sourceActorId: "worker-1",
      targetActorId: "lead",
      outputTree: oid("d"),
      destinationPath: leadPath,
      before: capture(leadPath),
      afterTree: oid("e"),
      scratchPath: path.join(folder, "scratch"),
      state: "attention",
      entries: [
        { path: filename, before: null, after: { path: filename, mode: "100755", oid: oid("f") } },
        { path: "old-link", before: { path: "old-link", mode: "120000", oid: oid("a") }, after: null },
      ],
      includedActorIds: ["worker-1"],
      error: "Interrupted after writing the first path",
      createdAt: 5_000,
      updatedAt: 5_001,
    };
    teamWorkspaces.savePublication(migrated, receipt);
    close(migrated);

    const reopened = Db.open(file);
    opened.add(reopened);
    expect(teamRuntime.get(reopened, record.id)).toEqual(completed);
    expect(teamRuntime.assignmentForTask(reopened, completed.actors[1]!.taskId!)).toEqual({ executionId: record.id, actorId: "worker-1" });
    expect(teamWorkspaces.list(reopened)).toEqual(retained);
    expect(teamWorkspaces.publications(reopened, record.id)).toEqual([receipt]);
    expect(teamWorkspaces.publication(reopened, receipt.id)).toEqual(receipt);
    const applied = teamWorkspaces.savePublication(reopened, { ...receipt, state: "applied", error: null, updatedAt: 6_000 });
    close(reopened);

    const finished = Db.open(file);
    opened.add(finished);
    expect(teamWorkspaces.publications(finished, record.id)).toEqual([applied]);
    expect(teamWorkspaces.get(finished, record.id, "worker-1")?.outputTree).toBe(oid("d"));
    expect(teamRuntime.get(finished, record.id)).toEqual(completed);
    expect(finished.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
