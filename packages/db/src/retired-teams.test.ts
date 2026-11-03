import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { Db } from "./database.js";
import { seedRetiredTeam } from "./fixtures/retired-team.js";
import { projects, tasks, threads } from "./repos.js";
import { retiredTeams } from "./retired-teams.js";
import { scheduleFirings, schedules } from "./schedules.js";
import { migrations } from "./schema.js";

it("upgrades saved teams without removing their history or work, and cancels scheduled execution", () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "retired-teams-"));
  const file = path.join(folder, "data.sqlite");
  let db = Db.open(file);
  try {
    const project = projects.insert(db, { name: "Saved work", rootPath: folder, defaultBranch: "main", gitRemote: null, settings: {} });
    const thread = threads.insert(db, { projectId: project.id, title: "Saved team", agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted" });
    threads.update(db, thread.id, { worktreePath: path.join(folder, "saved-worktree"), branch: "openorc/old-team" });
    const { revisionId, instanceId } = seedRetiredTeam(db, thread);
    const task = tasks.insert(db, {
      projectId: project.id,
      threadId: thread.id,
      title: "Saved task",
      spec: "Keep this work",
      priority: "none",
      labels: [],
      workspaceMode: "worktree",
      baseRef: null,
      parentTaskId: null,
    });
    db.stmt(
      "INSERT INTO team_room_events(instance_id,seq,id,author_kind,author_id,body,attachments,addressees,source,payload_hash,created_at) VALUES (?,1,'saved-message','member','lead','The work is saved.','[]','[]','say',?,1)",
    ).run(instanceId, "a".repeat(64));
    const schedule = schedules.insert(db, {
      projectId: project.id,
      title: "Old schedule",
      prompt: "Continue",
      agent: "codex",
      model: "fixture",
      effort: null,
      mode: "act",
      permissionMode: "trusted",
      workspaceMode: "worktree",
      everyMinutes: 60,
    });
    const target = JSON.stringify({ kind: "team", teamRevisionId: revisionId });
    db.stmt("UPDATE schedules SET execution_target=?, team_revision_id=?, enabled=1 WHERE id=?").run(target, revisionId, schedule.id);
    const snapshot = JSON.stringify({ ...schedule, executionTarget: JSON.parse(target) });
    db.stmt("INSERT INTO schedule_firings(id,schedule_id,request_key,schedule_version,trigger,snapshot,state,created_at) VALUES ('pending',?,'saved-request',1,'manual',?,'pending',1)").run(
      schedule.id,
      snapshot,
    );
    db.raw.exec(`PRAGMA user_version=${migrations.length - 1}`);
    db.close();
    db = Db.open(file);
    expect(schedules.get(db, schedule.id)).toMatchObject({ enabled: false, retiredTeam: true, executionTarget: null });
    expect(scheduleFirings.get(db, "pending")).toMatchObject({ state: "cancelled", reason: "Teams are no longer supported." });
    expect(retiredTeams.hasThread(db, thread.id)).toBe(true);
    expect(tasks.get(db, task.id)).toMatchObject({ retiredTeam: true, spec: "Keep this work" });
    expect(threads.get(db, thread.id)).toMatchObject({ branch: "openorc/old-team", worktreePath: path.join(folder, "saved-worktree") });
    expect(db.stmt("SELECT body FROM team_room_events WHERE id = ?").get("saved-message")).toMatchObject({ body: "The work is saved." });
    expect(threads.list(db, { filter: "all" })).toEqual([]);
    expect(tasks.list(db)).toEqual([]);
    expect(schedules.list(db)).toEqual([]);
    expect(db.stmt("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

it("hides forwarded tasks while preserving unrelated work in their creator conversation", () => {
  const db = Db.memory();
  try {
    const project = projects.insert(db, { name: "Current work", rootPath: "/current", defaultBranch: "main", gitRemote: null, settings: {} });
    const creator = threads.insert(db, { projectId: project.id, title: "Current conversation", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    const createTask = (title: string) =>
      tasks.insert(db, { projectId: project.id, threadId: creator.id, title, spec: null, priority: "none", labels: [], workspaceMode: "current", baseRef: null, parentTaskId: null });
    const forwarded = createTask("Previously forwarded");
    const current = createTask("Current task");
    db.stmt("INSERT INTO settings (key,value) VALUES (?,?)").run(`task.forwarding.target.${forwarded.id}`, JSON.stringify({ kind: "team" }));
    tasks.update(db, forwarded.id, { executionThreadId: creator.id });
    expect(tasks.list(db).map((task) => task.id)).toEqual([current.id]);
    expect(threads.list(db).map((thread) => thread.id)).toEqual([creator.id]);
    expect(tasks.get(db, forwarded.id)?.retiredTeam).toBe(true);
  } finally {
    db.close();
  }
});
