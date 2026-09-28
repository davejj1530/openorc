import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TEAM_LIMITS } from "@openorc/protocol";
import { Db } from "./database.js";
import { orchestration } from "./orchestration.js";
import { projects, tasks, threads } from "./repos.js";
import { teamContexts } from "./team-context.js";
import { teamContextParts } from "./team-context-parts.js";
import { teamDeletedThreads, teamDeletions, type CreateTeamDeletionInput } from "./team-deletions.js";
import { teamForks } from "./team-forks.js";

const opened = new Set<Db>();
afterEach(() => {
  for (const db of opened) db.close();
  opened.clear();
});
const settings = { agent: "codex" as const, model: "fixture", effort: "high", fastMode: false };
const hash = "b".repeat(64),
  sha = (value: string) => value.repeat(40);
const boundary = (db: Db, threadId: string) => (db.stmt("SELECT COALESCE(MAX(rowid),0) AS value FROM team_executions WHERE thread_id=?").get(threadId) as { value: number }).value;

function fixture(taskCount: number) {
  const db = Db.memory();
  opened.add(db);
  const project = projects.insert(db, { name: "Cleanup", rootPath: "/tmp/" + randomUUID(), defaultBranch: "main", gitRemote: null, settings: {} });
  const saved = orchestration.save(db, {
    projectId: project.id,
    expectedRevisionId: null,
    draft: { name: "Cleanup team", limits: DEFAULT_TEAM_LIMITS, members: [{ key: "lead", name: "Lead", managerKey: null, responsibility: "Work", settings }] },
  });
  const workspace = "/tmp/team-workspaces/" + randomUUID();
  let thread = threads.insert(db, { projectId: project.id, title: "Cleanup owner", ...settings, mode: "act", permissionMode: "review", workspaceMode: "worktree" });
  thread = threads.update(db, thread.id, { worktreePath: workspace, baseSha: sha("1"), branch: "openorc/team-" + thread.id });
  const instance = orchestration.createInstance(db, { threadId: thread.id, teamRevisionId: saved.revision.id });
  const saved_tasks = Array.from({ length: taskCount }, (_, index) =>
    tasks.insert(db, {
      projectId: project.id,
      threadId: thread.id,
      title: `Saved ${index}`,
      spec: "Spec",
      priority: "none",
      labels: [],
      workspaceMode: "worktree",
      baseRef: "main",
      parentTaskId: null,
      origin: "agent",
    }),
  );
  const base = (patch: Partial<CreateTeamDeletionInput>): CreateTeamDeletionInput => ({
    id: randomUUID(),
    threadId: thread.id,
    instanceId: instance.id,
    projectId: project.id,
    projectRoot: project.rootPath,
    requestKey: randomUUID(),
    requestHash: hash,
    retainedTaskIds: [],
    retainedPaths: [],
    entries: [],
    seed: null,
    throughExecutionRowid: boundary(db, thread.id),
    ...patch,
  });
  const entry = (path: string) => ({
    path,
    canonicalPath: "/private" + path,
    repositoryRoot: project.rootPath,
    commonDir: project.rootPath + "/.git",
    quarantinePath: path + ".deleting",
    identity: null,
    registration: null,
  });
  const hide = () => {
    const record = teamDeletions.create(db, base({ retainedTaskIds: saved_tasks.map((task) => task.id), seed: "Saved tasks keep their team" }));
    const checkpoint = teamContexts.create(db, {
      instanceId: instance.id,
      executionId: null,
      actorId: "lead",
      originExecutionId: null,
      reason: "compact",
      requestKey: "delete:" + record.id,
      seed: record.seed!,
    });
    teamDeletions.finish(db, record.id, { contextCheckpointId: checkpoint.id });
    return record;
  };
  return { db, project, saved, thread, instance, workspace, tasks: saved_tasks, base, entry, hide };
}

describe("final deletion of a hidden owner", () => {
  it("refuses deleted tasks on an ordinary conversation and requires a hidden owner to delete all of its tasks together", () => {
    const f = fixture(2);
    const [first, second] = f.tasks.map((task) => task.id) as [string, string];
    expect(() => teamDeletions.create(f.db, f.base({ deletedTaskIds: [first, second] }))).toThrow(/deleted together/);
    expect(() => teamDeletions.create(f.db, f.base({ retainedTaskIds: [first], deletedTaskIds: [second], seed: "x" }))).toThrow(/final deletion/);
    f.hide();
    expect(teamDeletedThreads.has(f.db, f.thread.id)).toBe(true);
    expect(() => teamDeletions.create(f.db, f.base({ retainedTaskIds: [first, second], seed: "again" }))).toThrow(/deleted together/);
    expect(() => teamDeletions.create(f.db, f.base({ deletedTaskIds: [first] }))).toThrow(/together must match/);
    expect(() => teamDeletions.create(f.db, f.base({}))).toThrow(/together must match/);
    // The schema enforces the same rules against raw rows.
    const raw = (captured: Record<string, unknown>) =>
      f.db
        .stmt("INSERT INTO team_deletions(id,thread_id,instance_id,project_id,request_key,request_hash,captured_input,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'pending',1,1)")
        .run(
          randomUUID(),
          f.thread.id,
          f.instance.id,
          f.project.id,
          randomUUID(),
          hash,
          JSON.stringify({ projectRoot: f.project.rootPath, retainedTaskIds: [], entries: [], retainedPaths: [], seed: null, throughExecutionRowid: boundary(f.db, f.thread.id), ...captured }),
        );
    expect(() => raw({ deletedTaskIds: [first] })).toThrow(/retained or deleted/);
    expect(() => raw({ deletedTaskIds: [first, first, second] })).toThrow(/retained or deleted/);
    expect(() => raw({ deletedTaskIds: [first, second, randomUUID()] })).toThrow(/retained or deleted/);
    expect(() => raw({ retainedTaskIds: [first, second], seed: "s" })).toThrow(/retained or deleted/);
    const record = teamDeletions.create(
      f.db,
      f.base({
        deletedTaskIds: [second, first],
        git: { branches: [{ name: "openorc/team-" + f.thread.id, tip: sha("a") }], refPrefixes: ["refs/openorc/teams/x/"] },
        exports: ["/tmp/exports/a.patch"],
      }),
    );
    expect(record).toMatchObject({ retainedTaskIds: [], deletedTaskIds: [second, first], state: "pending", exports: ["/tmp/exports/a.patch"] });
    expect(teamDeletions.get(f.db, record.id)!.git.branches).toEqual([{ name: "openorc/team-" + f.thread.id, tip: sha("a") }]);
    expect(() => teamDeletions.finish(f.db, record.id)).toThrow(/remove its owner and any deleted tasks/);
    threads.delete(f.db, f.thread.id);
    expect(() => teamDeletions.finish(f.db, record.id)).toThrow(/remove its owner and any deleted tasks/);
    expect(() => f.db.stmt("UPDATE team_deletions SET state='applied',updated_at=2 WHERE id=?").run(record.id)).toThrow(/absent owner and its deleted tasks/);
    tasks.delete(f.db, first);
    tasks.delete(f.db, second);
    expect(teamDeletions.finish(f.db, record.id).state).toBe("applied");
    expect(teamDeletedThreads.has(f.db, f.thread.id)).toBe(true);
    expect(orchestration.getInstance(f.db, f.thread.id)).toBeNull();
  });

  it("lets a final receipt remove a deleted task's own workspace pointer but no other task's", () => {
    const f = fixture(1);
    const own = f.tasks[0]!;
    tasks.update(f.db, own.id, { worktreePath: f.workspace });
    const other = tasks.insert(f.db, {
      projectId: f.project.id,
      threadId: null,
      title: "Other",
      spec: "Spec",
      priority: "none",
      labels: [],
      workspaceMode: "worktree",
      baseRef: "main",
      parentTaskId: null,
      origin: "user",
    });
    tasks.update(f.db, other.id, { worktreePath: "/tmp/other-" + randomUUID() });
    f.hide();
    expect(() => teamDeletions.create(f.db, f.base({ deletedTaskIds: [own.id], entries: [f.entry(f.workspace), f.entry(tasks.get(f.db, other.id)!.worktreePath!)] }))).toThrow(/only owned workspaces/);
    expect(teamDeletions.create(f.db, f.base({ deletedTaskIds: [own.id], entries: [f.entry(f.workspace)] })).entries.map((item) => item.path)).toEqual([f.workspace]);
  });

  it("removes stored context text only when nothing in the instance refers to it, including escaped receipt seeds", () => {
    const f = fixture(0);
    const referenced = teamContextParts.put(f.db, f.instance.id, "Referenced by a checkpoint");
    const nested = teamContextParts.put(f.db, f.instance.id, "Referenced only through another part");
    const viaPart = teamContextParts.put(f.db, f.instance.id, JSON.stringify({ stored: nested.id, bytes: nested.bytes }));
    const viaFork = teamContextParts.put(f.db, f.instance.id, "Referenced by a pending fork receipt");
    const orphan = teamContextParts.put(f.db, f.instance.id, "Nothing refers to this");
    teamContexts.create(f.db, {
      instanceId: f.instance.id,
      executionId: null,
      actorId: "lead",
      originExecutionId: null,
      reason: "compact",
      requestKey: "compact",
      seed: JSON.stringify({ canonical: { stored: referenced.id, bytes: referenced.bytes }, origin: { context: { stored: viaPart.id, bytes: viaPart.bytes } } }),
    });
    teamForks.create(f.db, {
      id: randomUUID(),
      sourceThreadId: f.thread.id,
      sourceInstanceId: f.instance.id,
      projectId: f.project.id,
      projectRoot: f.project.rootPath,
      destinationThreadId: randomUUID(),
      requestKey: "fork",
      requestHash: hash,
      setupInput: null,
      seed: JSON.stringify({ stored: viaFork.id, bytes: viaFork.bytes }),
      sourceRunId: null,
      upToRunId: null,
      teamRevisionId: f.saved.revision.id,
      leadOverrides: {},
      thread: { title: "Fork", ...settings, mode: "act", permissionMode: "review" },
      snapshot: { rootPath: f.project.rootPath, headSha: sha("1"), treeSha: sha("2"), branch: null, treeRef: "refs/openorc/tests/tree", headRef: "refs/openorc/tests/head", indexSha256: null },
    });
    for (const part of [referenced, nested, viaPart, viaFork]) expect(() => f.db.stmt("DELETE FROM team_context_parts WHERE id=?").run(part.id)).toThrow(/still referenced/);
    expect(teamContextParts.prune(f.db, f.instance.id)).toEqual([orphan.id]);
    expect(teamContextParts.get(f.db, f.instance.id, orphan.id)).toBeNull();
    expect(teamContextParts.prune(f.db, f.instance.id)).toEqual([]);
    expect(f.db.stmt("SELECT COUNT(*) AS n FROM team_context_parts").get()).toEqual({ n: 4 });
    expect(createHash("sha256").update("Nothing refers to this").digest("hex")).toBe(orphan.id);
  });
});
