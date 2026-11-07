import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { Db } from "./database.js";
import { migrations } from "./schema.js";
import { startedByAgentMigration, subagentIdentityMigration, subagentObservationMigration } from "./subagent-schema.js";
import { projects, runs, threads } from "./repos.js";
import { subagents } from "./subagents.js";
import { LedgerWriter, listEvents } from "./ledger.js";

it("migrates nested native identities to their full parent and merges earlier duplicate threads without losing history", () => {
  const raw = new DatabaseSync(":memory:");
  const db = new Db(raw);
  try {
    for (const migration of migrations) {
      if (migration === subagentIdentityMigration) break;
      if (typeof migration === "string") raw.exec(migration);
      else migration(raw);
    }
    const project = projects.insert(db, { name: "Fixture", rootPath: "/repo", gitRemote: null, defaultBranch: null, settings: {} });
    const make = (title: string) => threads.insert(db, { projectId: project.id, title, agent: "codex", model: null, mode: "act", permissionMode: "autonomous" });
    const root = make("Parent"),
      first = make("First"),
      duplicate = make("Duplicate"),
      nested = make("Nested");
    const host = (id: string) => runs.insert(db, { id, threadId: root.id, taskId: null, agent: "codex", model: null, mode: "act", permissionMode: "autonomous" });
    host("host1");
    host("host2");
    const child = (id: string, native: string, hostId: string, parent: string, time: number) => {
      threads.update(db, id, { parentThreadId: parent, parentRelation: "subagent" });
      runs.insert(db, { id: `run:${id}`, threadId: id, taskId: null, agent: "codex", model: null, mode: "act", permissionMode: "autonomous" });
      raw.prepare("INSERT INTO subagents(thread_id, run_id, host_run_id, native_id, status, started_at) VALUES (?, ?, ?, ?, 'completed', ?)").run(id, `run:${id}`, hostId, native, time);
    };
    child(first.id, "same", "host1", root.id, 1);
    child(duplicate.id, "same", "host2", root.id, 2);
    raw.prepare("UPDATE subagents SET status = 'running' WHERE thread_id = ?").run(duplicate.id);
    child(nested.id, "nested", "host2", duplicate.id, 3);
    db.transaction(() => {
      raw.prepare("INSERT INTO orchestration_teams(id,project_id,current_revision_id,created_at,updated_at) VALUES ('team',?,'revision',1,1)").run(project.id);
      raw.prepare("INSERT INTO orchestration_team_revisions(id,team_id,project_id,number,name,limits,created_at) VALUES ('revision','team',?,1,'Fixture','{}',1)").run(project.id);
    });
    for (const [index, thread] of [first, duplicate].entries()) {
      raw.prepare("INSERT INTO orchestration_team_instances(id,thread_id,project_id,team_revision_id,created_at) VALUES (?,?,?,'revision',1)").run(`instance${index}`, thread.id, project.id);
      raw
        .prepare("INSERT INTO conversation_plans (id,thread_id,run_id,document_id,revision,text,state,source,updated_at) VALUES (?,?,?,'doc',1,?,'ready','native',1)")
        .run(`plan${index}`, thread.id, `run:${thread.id}`, `Plan ${index}`);
      raw.prepare("INSERT INTO thread_queue (id,thread_id,request_key,text,attachments,state,created_at,updated_at) VALUES (?,?,'same','Message','[]','pending',1,1)").run(`queue${index}`, thread.id);
      raw.prepare("INSERT INTO cloud_workspaces (thread_id,provider,sandbox,state,created_at,updated_at) VALUES (?,'local',?,'preparing',1,1)").run(thread.id, `sandbox${index}`);
      raw
        .prepare("INSERT INTO orclings (id,name,look,agent,model,permission,thread_id,created_at,updated_at) VALUES (?,?,'{}','codex','model','allow',?,1,1)")
        .run(`orcling${index}`, `Orcling ${index}`, thread.id);
      raw.prepare("INSERT INTO pull_request_reviews (project_id,number,commit_id,thread_id,created_at,updated_at) VALUES (?,?,'sha',?,1,1)").run(project.id, index + 1, thread.id);
    }
    const ledger = new LedgerWriter(db);
    ledger.push({ type: "message.completed", runId: `run:${duplicate.id}`, ts: 2, messageId: "answer", role: "assistant", text: "Second answer" });
    ledger.push({ type: "subagent.started", runId: "host2", ts: 2, subagentId: "same", threadId: duplicate.id, title: "Duplicate" });
    ledger.close();
    subagentIdentityMigration(raw);
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(subagents.byNative(db, root.id, "same")?.threadId).toBe(first.id);
    expect(subagents.byNative(db, root.id, "nested")?.threadId).toBe(nested.id);
    expect(threads.get(db, nested.id)?.parentThreadId).toBe(first.id);
    expect(threads.get(db, duplicate.id)).toBeNull();
    expect(raw.prepare("SELECT text, revision FROM conversation_plans WHERE thread_id = ? ORDER BY revision").all(first.id)).toEqual([
      { text: "Plan 0", revision: 1 },
      { text: "Plan 1", revision: 2 },
    ]);
    expect(raw.prepare("SELECT id FROM thread_queue").all()).toEqual([{ id: "queue0" }]);
    expect(raw.prepare("SELECT sandbox FROM cloud_workspaces").all()).toEqual([{ sandbox: "sandbox0" }]);
    expect(raw.prepare("SELECT id FROM orclings").all()).toEqual([{ id: "orcling0" }]);
    expect(raw.prepare("SELECT thread_id FROM pull_request_reviews ORDER BY number").all()).toEqual([{ thread_id: first.id }, { thread_id: null }]);
    expect(raw.prepare("SELECT id,thread_id FROM orchestration_team_instances").all()).toEqual([{ id: "instance0", thread_id: first.id }]);
    const beforeObservation = raw.prepare("SELECT * FROM subagents ORDER BY thread_id").all();
    raw.exec(subagentObservationMigration);
    expect(raw.prepare("SELECT * FROM subagents ORDER BY thread_id").all()).toEqual(beforeObservation);
    raw.prepare("UPDATE subagents SET status = 'no_updates' WHERE thread_id = ?").run(first.id);
    expect(subagents.byThread(db, first.id)?.status).toBe("no_updates");
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(runs.listForThread(db, first.id)).toHaveLength(2);
    expect(
      runs
        .listForThread(db, first.id)
        .map((run) => run.state)
        .sort(),
    ).toEqual(["cancelled", "success"]);
    expect(subagents.byRun(db, `run:${duplicate.id}`)?.threadId).toBe(first.id);
    expect(listEvents(db, `run:${duplicate.id}`)[0]).toMatchObject({ text: "Second answer" });
    expect(listEvents(db, "host2")[0]).toMatchObject({ threadId: first.id });
    expect(() => raw.prepare("UPDATE subagents SET native_id = 'same' WHERE thread_id = ?").run(nested.id)).toThrow(/UNIQUE/);
  } finally {
    db.close();
  }
});

it("marks the threads started before people could start one as an agent's, on their parent's branch when they share its worktree, once", () => {
  const raw = new DatabaseSync(":memory:");
  const db = new Db(raw);
  try {
    for (const migration of migrations.slice(0, migrations.indexOf(startedByAgentMigration))) {
      if (typeof migration === "string") raw.exec(migration);
      else migration(raw);
    }
    const project = projects.insert(db, { name: "Fixture", rootPath: "/repo", gitRemote: null, defaultBranch: null, settings: {} });
    const make = (title: string) => threads.insert(db, { projectId: project.id, title, agent: "codex", model: null, mode: "act", permissionMode: "autonomous" });
    const root = make("Parent"),
      started = make("Started"),
      subagent = make("Subagent");
    const elsewhere = make("Elsewhere");
    threads.update(db, root.id, { worktreePath: "/worktrees/landing", branch: "openorc/landing" });
    threads.update(db, started.id, { parentThreadId: root.id, parentRelation: "started", worktreePath: "/worktrees/landing" });
    threads.update(db, elsewhere.id, { parentThreadId: root.id, parentRelation: "started" });
    threads.update(db, subagent.id, { parentThreadId: root.id, parentRelation: "subagent", worktreePath: "/worktrees/landing" });
    startedByAgentMigration(raw);
    const after = [root, started, elsewhere, subagent].map((thread) => threads.get(db, thread.id)!);
    expect(after.map((thread) => thread.startedByAgent)).toEqual([false, true, true, false]);
    expect(after.map((thread) => thread.branch)).toEqual(["openorc/landing", "openorc/landing", null, null]);
    const mine = make("Mine");
    threads.update(db, mine.id, { parentThreadId: root.id, parentRelation: "started" });
    startedByAgentMigration(raw);
    expect(threads.get(db, mine.id)?.startedByAgent).toBe(false);
  } finally {
    db.close();
  }
});
