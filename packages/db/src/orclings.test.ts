import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultOrclingLook, WORKSPACE_ID, type OrclingDraft, type TeamDraft } from "@openorc/protocol";
import { Db } from "./database.js";
import { memories } from "./memories.js";
import { orchestration } from "./orchestration.js";
import { orclingMigration } from "./orcling-schema.js";
import { orclings } from "./orclings.js";
import { pullReviews } from "./pull-reviews.js";
import { projects, runs, threads } from "./repos.js";
import { migrations } from "./schema.js";

const opened: Db[] = [];
const folders: string[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const draft: OrclingDraft = { name: "Gloop", look: defaultOrclingLook, settings: { agent: "claude", model: "fixture", effort: null, fastMode: false }, permission: "approve" };

function withOrcling() {
  const db = Db.memory();
  opened.push(db);
  projects.insert(db, { name: "Workspace", rootPath: "/tmp/workspace", gitRemote: null, defaultBranch: null, settings: {} });
  db.stmt("UPDATE projects SET id = ? WHERE name = 'Workspace'").run(WORKSPACE_ID);
  const home = threads.insert(db, { projectId: WORKSPACE_ID, title: "Gloop", agent: "claude", model: "fixture", mode: "act", permissionMode: "review" });
  const orcling = orclings.insert(db, { id: "gloop", draft, threadId: home.id });
  threads.update(db, home.id, { orclingId: orcling.id });
  return { db, home, orcling };
}

it("upgrades a ledger from before Orclings with its threads, runs and memories unchanged", () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "openorc-orcling-migration-"));
  folders.push(folder);
  const file = path.join(folder, "ledger.sqlite");
  const raw = new DatabaseSync(file);
  const before = migrations.indexOf(orclingMigration);
  for (const migration of migrations.slice(0, before)) typeof migration === "string" ? raw.exec(migration) : migration(raw);
  raw.exec(`PRAGMA user_version=${before}`);
  raw.exec(`INSERT INTO projects (id,name,root_path,settings,created_at,updated_at) VALUES ('p','App','/tmp/app','{}',1,1)`);
  raw.exec(`INSERT INTO threads (id,project_id,title,agent,model,created_at,updated_at,last_activity_at) VALUES ('t','p','Old','codex','fixture',1,1,1)`);
  raw.exec(`INSERT INTO runs (id,thread_id,agent,model,external_session_id,state,started_at) VALUES ('r','t','codex','fixture','s','done',1)`);
  raw.exec(`INSERT INTO memories (id,project_id,type,title,body,created_at,updated_at,last_confirmed_at) VALUES ('m','p','lesson','Old lesson','Kept as it was.',1,1,1)`);
  raw.close();

  const db = Db.open(file);
  opened.push(db);
  expect(db.version).toBe(migrations.length);
  expect(threads.get(db, "t")?.orclingId).toBeNull();
  expect(runs.get(db, "r")?.orclingId).toBeNull();
  expect(runs.lastSession(db, { threadId: "t" }, "codex")).toBe("s");
  expect(memories.list(db, { projectId: "p" })).toMatchObject([{ id: "m", scope: "project", orclingId: null }]);
  expect(db.stmt("PRAGMA foreign_key_check").all()).toEqual([]);
});

it("keeps every version of an Orcling's instructions, newest first", () => {
  const { db, orcling } = withOrcling();
  orclings.appendInstructions(db, orcling.id, { body: "Be brief.", author: "user", note: null });
  orclings.appendInstructions(db, orcling.id, { body: "Be brief and warm.", author: "orcling", note: "They liked a friendlier tone" });
  expect(orclings.currentInstructions(db, orcling.id)).toMatchObject({ version: 2, body: "Be brief and warm.", author: "orcling" });
  expect(orclings.instructions(db, orcling.id).map((entry) => entry.version)).toEqual([2, 1]);
  orclings.delete(db, orcling.id);
  expect(orclings.instructions(db, orcling.id)).toEqual([]);
});

it("resumes a thread's own session, never an Orcling guest's", () => {
  const { db, orcling } = withOrcling();
  const thread = threads.insert(db, { projectId: WORKSPACE_ID, title: "Plain", agent: "claude", model: "fixture", mode: "act", permissionMode: "review" });
  runs.insert(db, { id: "own", taskId: null, threadId: thread.id, agent: "claude", model: "fixture", mode: "act", permissionMode: "review" });
  runs.update(db, "own", { externalSessionId: "own-session" });
  runs.insert(db, { id: "guest", taskId: null, threadId: thread.id, agent: "claude", model: "fixture", mode: "act", permissionMode: "review", orclingId: orcling.id });
  runs.update(db, "guest", { externalSessionId: "guest-session" });
  expect(runs.lastSession(db, { threadId: thread.id }, "claude")).toBe("own-session");
  expect(runs.lastSession(db, { threadId: thread.id }, "claude", orcling.id)).toBe("guest-session");
});

it("seats an Orcling under its own current name and model, and gives the seat back to what was saved once it is deleted", () => {
  const { db, orcling } = withOrcling();
  const project = projects.insert(db, { name: "App", rootPath: "/tmp/app", gitRemote: null, defaultBranch: "main", settings: {} });
  const team: TeamDraft = {
    name: "Pair",
    members: [
      { key: "lead", name: "Lead", managerKey: null, responsibility: "Coordinate.", settings: { agent: "codex", model: "fixture", effort: null, fastMode: false } },
      { key: "gloop", name: "Gloop", managerKey: "lead", responsibility: "Review the work.", settings: draft.settings, orclingId: orcling.id },
    ],
    limits: { maxConcurrentAgents: 2, maxAssignments: 4, maxExecutionMinutes: 30, maxAttemptsPerAssignment: 1 },
  };
  const saved = orchestration.save(db, { projectId: project.id, expectedRevisionId: null, draft: team });
  const seat = () => orchestration.getRevision(db, saved.revision.id)!.members[1]!;
  expect(orchestration.getRevision(db, saved.revision.id)?.members.map((member) => member.orclingId ?? null)).toEqual([null, orcling.id]);

  orclings.update(db, orcling.id, { ...draft, name: "Glorp", settings: { agent: "codex", model: "smarter", effort: "high", fastMode: true } });
  expect(seat()).toMatchObject({ name: "Glorp", orclingId: orcling.id, settings: { agent: "codex", model: "smarter", effort: "high", fastMode: true } });

  orclings.delete(db, orcling.id);
  expect(seat().orclingId).toBeUndefined();
  expect(seat()).toMatchObject({ name: "Gloop", settings: draft.settings });
});

it("remembers which Orcling drafted a pull request review comment, until the Orcling is deleted", () => {
  const { db, orcling } = withOrcling();
  const project = projects.insert(db, { name: "App", rootPath: "/tmp/app", gitRemote: null, defaultBranch: "main", settings: {} });
  const key = { projectId: project.id, number: 7 };
  pullReviews.open(db, key, "a".repeat(40));
  const line = { path: "src/app.ts", startLine: null, startSide: null, line: 12, side: "new" as const, lineText: null, body: "Close the server on error." };
  const drafted = pullReviews.addComment(db, key, { ...line, author: { agent: "claude", model: "fixture", orclingId: orcling.id } });
  expect(pullReviews.get(db, key)!.comments).toEqual([drafted]);

  orclings.delete(db, orcling.id);
  expect(pullReviews.get(db, key)!.comments[0]!.author).toEqual({ agent: "claude", model: "fixture" });
});
