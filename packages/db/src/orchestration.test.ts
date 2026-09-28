import { insertLegacyRun } from "./fixtures/legacy-run.js";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assignDefaultTeamAvatarIndices, harnessIds, DEFAULT_TEAM_AVATAR_POOL_SIZE, type TeamDraft } from "@openorc/protocol";
import { Db } from "./database.js";
import { orchestration } from "./orchestration.js";
import { projects, runs, threads } from "./repos.js";
import { migrations } from "./schema.js";

const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

function fixture() {
  const db = Db.memory();
  opened.push(db);
  const project = projects.insert(db, { name: "App", rootPath: "/tmp/orchestration-app", gitRemote: null, defaultBranch: "main", settings: {} });
  const otherProject = projects.insert(db, { name: "Other", rootPath: "/tmp/orchestration-other", gitRemote: null, defaultBranch: "main", settings: {} });
  return { db, project, otherProject };
}

function draft(): TeamDraft {
  return {
    name: "Delivery team",
    members: [
      {
        key: "lead",
        name: "Lead",
        managerKey: null,
        responsibility: "Coordinate the requested work and report the combined result.",
        settings: { agent: "codex", model: "gpt-6-astra", effort: "high", fastMode: false },
      },
      { key: "ui", name: "UI engineer", managerKey: "lead", responsibility: "Implement interface changes.", settings: { agent: "codex", model: "gpt-5.6-sol", effort: "medium", fastMode: false } },
      { key: "core", name: "Core engineer", managerKey: "lead", responsibility: "Implement backend changes.", settings: { agent: "codex", model: "gpt-5.6-sol", effort: "medium", fastMode: true } },
    ],
    limits: { maxConcurrentAgents: 3, maxAssignments: 24, maxExecutionMinutes: 60, maxAttemptsPerAssignment: 2 },
  };
}

function addThread(db: Db, projectId: string) {
  return threads.insert(db, { projectId, title: "A conversation", agent: "codex", model: "gpt-6-astra", mode: "act", permissionMode: "trusted" });
}

function rowCount(db: Db, table: string): number {
  return Number((db.stmt(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }).total);
}

describe("saved orchestration teams", () => {
  it.each(harnessIds)("saves and pins %s members from every registered harness", (agent) => {
    const { db, project } = fixture();
    const roster = draft();
    roster.members[0]!.settings = { agent, model: agent === "opencode" ? "openrouter/acme/fast" : "fixture", effort: null, fastMode: false };
    const saved = orchestration.save(db, { projectId: project.id, expectedRevisionId: null, draft: roster });
    const thread = addThread(db, project.id);
    const instance = orchestration.createInstance(db, { threadId: thread.id, teamRevisionId: saved.revision.id });
    expect(orchestration.get(db, saved.team.id)?.revision.members).toEqual(roster.members);
    expect(orchestration.getInstance(db, thread.id)).toEqual(instance);
  });

  it("keeps discussion settings with the revision that carries them and reads older revisions without any", () => {
    const { db, project } = fixture();
    const plain = orchestration.save(db, { projectId: project.id, expectedRevisionId: null, draft: draft() });
    expect(plain.revision.discussion).toBeUndefined();
    const discussion = { ambientRounds: 2, peerFollowUps: 1, mentionOnly: [draft().members[1]!.key] };
    const talkative = orchestration.save(db, { projectId: project.id, teamId: plain.team.id, expectedRevisionId: plain.revision.id, draft: { ...draft(), discussion } });
    expect(talkative.revision.discussion).toEqual(discussion);
    expect(orchestration.getRevision(db, plain.revision.id)?.discussion).toBeUndefined();
    expect(orchestration.getRevision(db, talkative.revision.id)?.discussion).toEqual(discussion);
  });

  it("rejects malformed stored revision limits and lead overrides before exposing them", () => {
    const { db, project } = fixture();
    const saved = orchestration.save(db, { projectId: project.id, expectedRevisionId: null, draft: draft() });
    db.stmt("INSERT INTO orchestration_team_revisions (id,team_id,project_id,number,name,limits,sealed,created_at) VALUES ('malformed',?,?,2,'Broken','{}',1,1)").run(saved.team.id, project.id);
    expect(() => orchestration.getRevision(db, "malformed")).toThrow();

    const thread = addThread(db, project.id);
    const instance = orchestration.createInstance(db, { threadId: thread.id, teamRevisionId: saved.revision.id });
    db.stmt("UPDATE orchestration_team_instances SET lead_overrides=? WHERE id=?").run('{"fastMode":"yes"}', instance.id);
    expect(() => orchestration.getInstance(db, thread.id)).toThrow();
    db.stmt("UPDATE orchestration_team_instances SET lead_overrides=? WHERE id=?").run("{}", instance.id);
    expect(orchestration.getInstance(db, thread.id)).toEqual(instance);
  });

  it("appends immutable revisions and rejects a stale editor without leaving a partial revision", () => {
    const { db, project } = fixture();
    const first = orchestration.save(db, { projectId: project.id, expectedRevisionId: null, draft: draft() });
    const edited = draft();
    edited.name = "Revised delivery";
    edited.members[1]!.settings.effort = "high";
    const second = orchestration.save(db, { projectId: project.id, teamId: first.team.id, expectedRevisionId: first.revision.id, draft: edited });
    expect(second.revision.number).toBe(2);
    expect(second.revision.id).not.toBe(first.revision.id);
    expect(orchestration.getRevision(db, first.revision.id)).toEqual(first.revision);
    expect(() => orchestration.save(db, { projectId: project.id, teamId: first.team.id, expectedRevisionId: first.revision.id, draft: draft() })).toThrow(/latest revision/);
    expect(rowCount(db, "orchestration_team_revisions")).toBe(2);
    expect(orchestration.get(db, first.team.id)).toEqual(second);
    expect(() => db.stmt("UPDATE orchestration_team_revisions SET name = 'Rewritten' WHERE id = ?").run(first.revision.id)).toThrow(/immutable/);
    expect(() => db.stmt("UPDATE orchestration_team_revisions SET sealed = 0 WHERE id = ?").run(first.revision.id)).toThrow(/immutable/);
    expect(() => db.stmt("UPDATE orchestration_team_members SET model = 'another-model' WHERE revision_id = ?").run(first.revision.id)).toThrow(/immutable/);
    expect(() => db.stmt("DELETE FROM orchestration_team_members WHERE revision_id = ?").run(first.revision.id)).toThrow(/retained/);
    expect(() => db.stmt("DELETE FROM orchestration_team_revisions WHERE id = ?").run(first.revision.id)).toThrow(/retained/);
    expect(() =>
      db
        .stmt(
          "INSERT INTO orchestration_team_members (revision_id, member_key, position, name, responsibility, manager_key, agent, model, fast_mode) VALUES (?, 'extra', 5, 'Extra', 'Work', 'lead', 'codex', 'gpt-5.6-sol', 0)",
        )
        .run(first.revision.id),
    ).toThrow(/immutable/);
  });

  it("validates ownership and expected revision for every configuration write", () => {
    const { db, project, otherProject } = fixture();
    const saved = orchestration.save(db, { projectId: project.id, expectedRevisionId: null, draft: draft() });
    expect(orchestration.list(db, otherProject.id, true)).toEqual([]);
    expect(() => orchestration.save(db, { projectId: otherProject.id, teamId: saved.team.id, expectedRevisionId: saved.revision.id, draft: draft() })).toThrow(/this project/);
    expect(() => orchestration.archive(db, { projectId: otherProject.id, teamId: saved.team.id, expectedRevisionId: saved.revision.id, archived: true })).toThrow(/this project/);
    expect(() => orchestration.save(db, { projectId: project.id, expectedRevisionId: saved.revision.id, draft: draft() })).toThrow(/new team/);
    expect(() => orchestration.save(db, { projectId: project.id, teamId: saved.team.id, expectedRevisionId: null, draft: draft() })).toThrow(/latest revision/);
    expect(() => orchestration.archive(db, { projectId: project.id, teamId: saved.team.id, expectedRevisionId: "stale", archived: true })).toThrow(/latest revision/);
    expect(() => orchestration.save(db, { projectId: "missing", expectedRevisionId: null, draft: draft() })).toThrow(/Project not found/);
    expect(orchestration.get(db, saved.team.id)).toEqual(saved);
  });

  it.each([""])("rejects an explicit empty team ID %j instead of creating another team", (teamId) => {
    const { db, project } = fixture();
    expect(() => orchestration.save(db, { projectId: project.id, teamId, expectedRevisionId: null, draft: draft() })).toThrow(/Team ID cannot be empty/);
    expect(orchestration.list(db, project.id, true)).toEqual([]);
    expect(rowCount(db, "orchestration_team_revisions")).toBe(0);
  });

  it("cannot move an unsealed member into an immutable saved revision", () => {
    const { db, project } = fixture();
    const saved = orchestration.save(db, { projectId: project.id, expectedRevisionId: null, draft: draft() });
    db.stmt("INSERT INTO orchestration_team_revisions (id, team_id, project_id, number, name, limits, created_at) VALUES ('unsealed', ?, ?, 2, 'Draft', ?, 1)").run(
      saved.team.id,
      project.id,
      JSON.stringify(saved.revision.limits),
    );
    db.stmt(
      "INSERT INTO orchestration_team_members (revision_id, member_key, position, name, responsibility, manager_key, agent, model, fast_mode) VALUES ('unsealed', 'extra', 3, 'Extra', 'Work', NULL, 'codex', 'gpt-5.6-sol', 0)",
    ).run();

    expect(() => db.stmt("UPDATE orchestration_team_members SET revision_id = ?, manager_key = 'lead' WHERE revision_id = 'unsealed'").run(saved.revision.id)).toThrow(/immutable/);
    expect(orchestration.getRevision(db, saved.revision.id)).toEqual(saved.revision);
  });

  it.each(["cycle", "missing manager", "two leads", "duplicate key", "duplicate name", "four levels"])("rejects an invalid %s before persisting any rows", (invalid) => {
    const { db, project } = fixture();
    const value = draft();
    if (invalid === "cycle") {
      value.members[1]!.managerKey = "core";
      value.members[2]!.managerKey = "ui";
    }
    if (invalid === "missing manager") value.members[1]!.managerKey = "missing";
    if (invalid === "two leads") value.members[1]!.managerKey = null;
    if (invalid === "duplicate key") value.members[2]!.key = "ui";
    if (invalid === "duplicate name") value.members[2]!.name = "ui ENGINEER";
    if (invalid === "four levels") {
      value.members[2]!.managerKey = "ui";
      value.members.push({ ...value.members[2]!, key: "fourth", name: "Fourth member", managerKey: "core" });
    }
    expect(() => orchestration.save(db, { projectId: project.id, expectedRevisionId: null, draft: value })).toThrow();
    expect(orchestration.list(db, project.id, true)).toEqual([]);
    expect(rowCount(db, "orchestration_team_revisions")).toBe(0);
    expect(rowCount(db, "orchestration_team_members")).toBe(0);
  });

  it("archives idempotently, retains history, and requires restoration before editing", () => {
    const { db, project } = fixture();
    const saved = orchestration.save(db, { projectId: project.id, expectedRevisionId: null, draft: draft() });
    const input = { projectId: project.id, teamId: saved.team.id, expectedRevisionId: saved.revision.id, archived: true };
    const archived = orchestration.archive(db, input);
    expect(archived.team.archivedAt).not.toBeNull();
    expect(orchestration.archive(db, input)).toEqual(archived);
    expect(orchestration.list(db, project.id)).toEqual([]);
    expect(orchestration.list(db, project.id, true)).toEqual([archived]);
    expect(orchestration.getRevision(db, saved.revision.id)).toEqual(saved.revision);
    expect(() => orchestration.save(db, { projectId: project.id, teamId: saved.team.id, expectedRevisionId: saved.revision.id, draft: draft() })).toThrow(/Restore/);
    const restored = orchestration.archive(db, { ...input, archived: false });
    expect(restored.team.archivedAt).toBeNull();
    expect(orchestration.list(db, project.id)).toEqual([restored]);
    expect(rowCount(db, "orchestration_team_revisions")).toBe(1);
    expect(rowCount(db, "runs")).toBe(0);
    expect(rowCount(db, "tasks")).toBe(0);
  });
});

describe("team member avatars", () => {
  it("assigns deterministic, distinct defaults and respects indices already held by teammates", () => {
    const roster = ["lead", "vice", "sol-1", "sol-2", "sol-qa"];
    const first = assignDefaultTeamAvatarIndices(roster, DEFAULT_TEAM_AVATAR_POOL_SIZE);
    const repeated = assignDefaultTeamAvatarIndices(roster, DEFAULT_TEAM_AVATAR_POOL_SIZE);

    expect([...repeated]).toEqual([...first]);
    expect(new Set(first.values()).size).toBe(roster.length);
    expect([...first.values()].every((index) => index >= 0 && index < DEFAULT_TEAM_AVATAR_POOL_SIZE)).toBe(true);

    const reserved = [first.get("lead")!, first.get("vice")!];
    const newcomers = assignDefaultTeamAvatarIndices(["newcomer-a", "newcomer-b"], DEFAULT_TEAM_AVATAR_POOL_SIZE, reserved);
    expect([...newcomers.values()].some((index) => reserved.includes(index))).toBe(false);
  });

  it("bounds reuse when the avatar pool is exhausted and rejects invalid allocation inputs", () => {
    const exhausted = assignDefaultTeamAvatarIndices(["one", "two", "three"], 2);
    expect(exhausted.size).toBe(3);
    expect([...exhausted.values()].every((index) => index === 0 || index === 1)).toBe(true);
    expect(() => assignDefaultTeamAvatarIndices(["duplicate", "duplicate"], 12)).toThrow(/Duplicate/);
    expect(() => assignDefaultTeamAvatarIndices(["member"], 0)).toThrow(/at least one/);
  });

  it("materializes defaults lazily and preserves allocations across custom selection, reset, and roster edits", () => {
    const { db, project } = fixture();
    const saved = orchestration.save(db, { projectId: project.id, expectedRevisionId: null, draft: draft() });
    expect(rowCount(db, "orchestration_team_member_avatars")).toBe(0);

    const initial = orchestration.listMemberAvatars(db, saved.team.id);
    expect(initial.map((item) => item.memberKey)).toEqual(["lead", "ui", "core"]);
    expect(new Set(initial.map((item) => (item.avatar.kind === "default" ? item.avatar.index : -1))).size).toBe(3);
    expect(rowCount(db, "orchestration_team_member_avatars")).toBe(3);

    const uiDefault = initial.find((item) => item.memberKey === "ui")!.avatar;
    expect(uiDefault.kind).toBe("default");
    const custom = orchestration.setMemberAvatar(db, {
      teamId: saved.team.id,
      memberKey: "ui",
      avatar: { kind: "custom", path: "team-avatars/team/ui.webp" },
    });
    expect(custom.avatar).toEqual({ kind: "custom", path: "team-avatars/team/ui.webp" });
    expect(Number((db.stmt("SELECT default_index FROM orchestration_team_member_avatars WHERE team_id = ? AND member_key = 'ui'").get(saved.team.id) as { default_index: number }).default_index)).toBe(
      uiDefault.kind === "default" ? uiDefault.index : -1,
    );
    expect(orchestration.resetMemberAvatar(db, { teamId: saved.team.id, memberKey: "ui" }).avatar).toEqual(uiDefault);

    const changed = draft();
    changed.members = [
      changed.members[2]!,
      changed.members[0]!,
      { key: "qa", name: "QA", managerKey: "lead", responsibility: "Verify the result.", settings: { agent: "codex", model: "gpt-5.6-sol", effort: "high", fastMode: false } },
    ];
    const revised = orchestration.save(db, { projectId: project.id, teamId: saved.team.id, expectedRevisionId: saved.revision.id, draft: changed });
    const afterEdit = orchestration.listMemberAvatars(db, saved.team.id);
    expect(afterEdit.map((item) => item.memberKey)).toEqual(["core", "lead", "qa"]);
    for (const key of ["lead", "core"]) {
      expect(afterEdit.find((item) => item.memberKey === key)?.avatar).toEqual(initial.find((item) => item.memberKey === key)?.avatar);
    }
    expect(new Set(afterEdit.map((item) => (item.avatar.kind === "default" ? item.avatar.index : -1))).size).toBe(3);

    const reordered = { ...changed, members: [changed.members[1]!, changed.members[2]!, changed.members[0]!] };
    orchestration.save(db, { projectId: project.id, teamId: saved.team.id, expectedRevisionId: revised.revision.id, draft: reordered });
    const afterReorder = orchestration.listMemberAvatars(db, saved.team.id);
    for (const key of ["lead", "core", "qa"]) {
      expect(afterReorder.find((item) => item.memberKey === key)?.avatar).toEqual(afterEdit.find((item) => item.memberKey === key)?.avatar);
    }
    expect(() => orchestration.setMemberAvatar(db, { teamId: saved.team.id, memberKey: "ui", avatar: { kind: "default", index: 0 } })).toThrow(/current revision/);
  });

  it("persists custom avatar state through a database reopen", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "openorc-avatar-persistence-"));
    const file = path.join(directory, "app.sqlite");
    let db: Db | null = null;
    try {
      db = Db.open(file);
      const project = projects.insert(db, { name: "App", rootPath: directory, gitRemote: null, defaultBranch: "main", settings: {} });
      const saved = orchestration.save(db, { projectId: project.id, expectedRevisionId: null, draft: draft() });
      const initial = orchestration.listMemberAvatars(db, saved.team.id);
      orchestration.setMemberAvatar(db, { teamId: saved.team.id, memberKey: "lead", avatar: { kind: "custom", path: "team-avatars/team/lead.png" } });
      db.close();
      db = Db.open(file);

      expect(orchestration.listMemberAvatars(db, saved.team.id)).toEqual(
        initial.map((item) => (item.memberKey === "lead" ? { ...item, avatar: { kind: "custom", path: "team-avatars/team/lead.png" }, updatedAt: expect.any(Number) } : item)),
      );
    } finally {
      db?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("pinned team identities", () => {
  it("enforces project ownership and a single instance per thread in both repository and SQL", () => {
    const { db, project, otherProject } = fixture();
    const saved = orchestration.save(db, { projectId: project.id, expectedRevisionId: null, draft: draft() });
    const thread = addThread(db, project.id);
    const foreignThread = addThread(db, otherProject.id);
    expect(() => orchestration.createInstance(db, { threadId: foreignThread.id, teamRevisionId: saved.revision.id })).toThrow(/thread's project/);
    expect(() =>
      db
        .stmt("INSERT INTO orchestration_team_instances (id, thread_id, project_id, team_revision_id, created_at) VALUES ('foreign', ?, ?, ?, 1)")
        .run(foreignThread.id, otherProject.id, saved.revision.id),
    ).toThrow(/FOREIGN KEY/);
    expect(orchestration.getInstance(db, foreignThread.id)).toBeNull();
    const instance = orchestration.createInstance(db, { threadId: thread.id, teamRevisionId: saved.revision.id });
    expect(() => orchestration.createInstance(db, { threadId: thread.id, teamRevisionId: saved.revision.id })).toThrow(/already has/);
    expect(() =>
      db.stmt("INSERT INTO orchestration_team_instances (id, thread_id, project_id, team_revision_id, created_at) VALUES ('duplicate', ?, ?, ?, 1)").run(thread.id, project.id, saved.revision.id),
    ).toThrow(/UNIQUE/);
    expect(orchestration.getInstance(db, thread.id)).toEqual(instance);
  });

  it("retains existing instances on archive but rejects new pins", () => {
    const { db, project } = fixture();
    const saved = orchestration.save(db, { projectId: project.id, expectedRevisionId: null, draft: draft() });
    const thread = addThread(db, project.id);
    const instance = orchestration.createInstance(db, { threadId: thread.id, teamRevisionId: saved.revision.id });
    orchestration.archive(db, { projectId: project.id, teamId: saved.team.id, expectedRevisionId: saved.revision.id, archived: true });
    expect(orchestration.getInstance(db, thread.id)).toEqual(instance);
    const laterThread = addThread(db, project.id);
    expect(() => orchestration.createInstance(db, { threadId: laterThread.id, teamRevisionId: saved.revision.id })).toThrow(/archived team/);
    expect(orchestration.getInstance(db, laterThread.id)).toBeNull();
  });

  it("cleans thread identities independently and allows project cascade deletion", () => {
    const { db, project } = fixture();
    const saved = orchestration.save(db, { projectId: project.id, expectedRevisionId: null, draft: draft() });
    const first = addThread(db, project.id);
    const second = addThread(db, project.id);
    orchestration.createInstance(db, { threadId: first.id, teamRevisionId: saved.revision.id });
    const retained = orchestration.createInstance(db, { threadId: second.id, teamRevisionId: saved.revision.id });
    threads.delete(db, first.id);
    expect(orchestration.getInstance(db, first.id)).toBeNull();
    expect(orchestration.getInstance(db, second.id)).toEqual(retained);
    expect(orchestration.getRevision(db, saved.revision.id)).toEqual(saved.revision);
    db.stmt("DELETE FROM projects WHERE id = ?").run(project.id);
    expect(orchestration.get(db, saved.team.id)).toBeNull();
    expect(rowCount(db, "orchestration_team_revisions")).toBe(0);
    expect(rowCount(db, "orchestration_team_members")).toBe(0);
    expect(rowCount(db, "orchestration_instance_members")).toBe(0);
    expect(db.stmt("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

describe("orchestration migration", () => {
  it("upgrades version 35 with pinned teams, preserving history, hierarchy and immutable guards", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "openorc-team-harness-migration-"));
    const file = path.join(directory, "app.sqlite");
    let db: Db | null = null;
    try {
      const raw = new DatabaseSync(file);
      // Version 35 shipped with the Codex/Claude-only team table.
      for (const migration of migrations.slice(0, 35)) {
        if (typeof migration === "string") raw.exec(migration);
        else migration(raw);
      }
      raw.exec("PRAGMA user_version = 35");
      db = new Db(raw);
      const project = projects.insert(db, { name: "Existing", rootPath: directory, gitRemote: null, defaultBranch: "main", settings: {} });
      const roster = draft();
      roster.members[1]!.settings.agent = "claude";
      roster.members[2]!.managerKey = roster.members[1]!.key;
      const saved = orchestration.save(db, { projectId: project.id, expectedRevisionId: null, draft: roster });
      const thread = addThread(db, project.id);
      const instance = orchestration.createInstance(db, { threadId: thread.id, teamRevisionId: saved.revision.id });
      const avatars = orchestration.listMemberAvatars(db, saved.team.id);
      const originalRows = db.stmt("SELECT rowid,* FROM orchestration_team_members ORDER BY rowid").all();
      db.close();
      db = Db.open(file);
      expect(db.version).toBe(migrations.length);
      expect(orchestration.get(db, saved.team.id)).toEqual(saved);
      expect(orchestration.getInstance(db, thread.id)).toEqual(instance);
      expect(orchestration.listMemberAvatars(db, saved.team.id)).toEqual(avatars);
      expect(db.stmt("SELECT rowid,* FROM orchestration_team_members ORDER BY rowid").all()).toEqual(originalRows);
      expect(() => db!.stmt("UPDATE orchestration_team_members SET model='changed' WHERE revision_id=?").run(saved.revision.id)).toThrow(/immutable/);
      expect(() => db!.stmt("DELETE FROM orchestration_team_members WHERE revision_id=?").run(saved.revision.id)).toThrow(/retained/);
      expect(() =>
        db!
          .stmt(
            "INSERT INTO orchestration_team_members SELECT revision_id,'extra',99,'Extra',responsibility,member_key,agent,model,effort,fast_mode FROM orchestration_team_members WHERE revision_id=? AND manager_key IS NULL",
          )
          .run(saved.revision.id),
      ).toThrow(/immutable/);
      roster.members[1]!.settings = { agent: "opencode", model: "openrouter/acme/fast", effort: null, fastMode: false };
      const updated = orchestration.save(db, { projectId: project.id, teamId: saved.team.id, expectedRevisionId: saved.revision.id, draft: roster });
      expect(orchestration.getRevision(db, saved.revision.id)).toEqual(saved.revision);
      expect(orchestration.getInstance(db, thread.id)).toEqual(instance);
      const nextThread = addThread(db, project.id);
      const nextInstance = orchestration.createInstance(db, { threadId: nextThread.id, teamRevisionId: updated.revision.id });
      db.close();
      db = Db.open(file);
      expect(orchestration.get(db, saved.team.id)).toEqual(updated);
      expect(orchestration.getInstance(db, nextThread.id)).toEqual(nextInstance);
      expect(db.stmt("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.stmt("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" });
      db.stmt("DELETE FROM projects WHERE id=?").run(project.id);
      expect(rowCount(db, "orchestration_team_members")).toBe(0);
      expect(rowCount(db, "orchestration_instance_members")).toBe(0);
      expect(db.stmt("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("upgrades a fixed version 7 database and preserves old conversations through reopening", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "openorc-team-migration-"));
    const file = path.join(directory, "app.sqlite");
    let db: Db | null = null;
    try {
      const raw = new DatabaseSync(file);
      // The shipped Fast-mode schema is version 7. Future migrations must not move this fixture.
      for (const migration of migrations.slice(0, 7)) {
        if (typeof migration === "string") raw.exec(migration);
        else migration(raw);
      }
      raw.exec("PRAGMA user_version = 7");
      const old = new Db(raw);
      const project = projects.insert(old, { name: "Existing", rootPath: directory, gitRemote: null, defaultBranch: "main", settings: {} });
      const thread = addThread(old, project.id);
      threads.update(old, thread.id, { fastMode: true, draft: "Unsent input" });
      insertLegacyRun(old, { id: "old-run", taskId: null, threadId: thread.id, agent: "codex", model: "gpt-6-astra", fastMode: true, mode: "act", permissionMode: "trusted" });
      old.close();

      db = Db.open(file);
      expect(db.version).toBe(migrations.length);
      expect(threads.get(db, thread.id)).toMatchObject({ fastMode: true, draft: "Unsent input" });
      expect(runs.get(db, "old-run")).toMatchObject({ fastMode: true, threadId: thread.id });
      expect(orchestration.list(db, project.id)).toEqual([]);
      expect(orchestration.getInstance(db, thread.id)).toBeNull();
      const saved = orchestration.save(db, { projectId: project.id, expectedRevisionId: null, draft: draft() });
      const instance = orchestration.createInstance(db, { threadId: thread.id, teamRevisionId: saved.revision.id });
      db.close();
      db = Db.open(file);
      expect(orchestration.get(db, saved.team.id)).toEqual(saved);
      expect(orchestration.getInstance(db, thread.id)).toEqual(instance);
      expect(runs.listForThread(db, thread.id)).toHaveLength(1);
      expect(db.stmt("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
