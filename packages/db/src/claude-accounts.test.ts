import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { Db } from "./database.js";
import { claudeAccounts } from "./claude-accounts.js";
import { projects, runs, threads } from "./repos.js";
import { schedules } from "./schedules.js";
import { claudeAccountMigration } from "./claude-account-schema.js";
import { migrations } from "./schema.js";

const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
const threadInput = { title: "Conversation", agent: "claude" as const, model: null, mode: "plan" as const, permissionMode: "review" as const };
function fixture() {
  const db = Db.memory();
  opened.push(db);
  const project = projects.insert(db, { name: "Fixture", rootPath: "/tmp/accounts-fixture", gitRemote: null, defaultBranch: "main", settings: {} });
  return { db, project };
}

it("pins threads and schedules to their original account after default changes", () => {
  const { db, project } = fixture();
  const original = threads.insert(db, { ...threadInput, projectId: project.id });
  const accounts = ["Work", "Personal", "Client"].map((name) => claudeAccounts.add(db, name));
  for (const account of accounts) {
    claudeAccounts.update(db, { id: account.id, makeDefault: true });
    const thread = threads.insert(db, { ...threadInput, projectId: project.id });
    const schedule = schedules.insert(db, { ...threadInput, projectId: project.id, prompt: "Review", effort: null, workspaceMode: "current", everyMinutes: 60 });
    expect(thread.claudeAccountId).toBe(account.id);
    expect(schedule.claudeAccountId).toBe(account.id);
    claudeAccounts.update(db, { id: "claude-cli", makeDefault: true });
    expect(threads.get(db, thread.id)?.claudeAccountId).toBe(account.id);
    expect(schedules.get(db, schedule.id)?.claudeAccountId).toBe(account.id);
  }
  expect(threads.get(db, original.id)?.claudeAccountId).toBe("claude-cli");
});

it("looks up resume sessions only within the chosen account", () => {
  const { db, project } = fixture();
  const thread = threads.insert(db, { ...threadInput, projectId: project.id });
  for (const name of ["Work", "Personal", "Client"]) {
    const account = claudeAccounts.add(db, name);
    const run = runs.insert(db, { ...threadInput, id: account.id, taskId: null, threadId: thread.id, claudeAccountId: account.id });
    runs.update(db, run.id, { externalSessionId: `session-${name}`, state: "success" });
    expect(runs.lastSession(db, { threadId: thread.id }, "claude", null, account.id)).toBe(`session-${name}`);
  }
  expect(runs.lastSession(db, { threadId: thread.id }, "claude", null, "claude-cli")).toBeNull();
});

it("migrates existing history and schedules to the existing CLI account", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "openorc-accounts-migration-"));
  const file = path.join(directory, "before.sqlite");
  try {
    const raw = new DatabaseSync(file);
    const before = migrations.indexOf(claudeAccountMigration);
    for (const migration of migrations.slice(0, before)) typeof migration === "string" ? raw.exec(migration) : migration(raw);
    raw.exec(`PRAGMA user_version = ${before}`);
    raw.exec("INSERT INTO projects (id,name,root_path,default_branch,settings,created_at,updated_at) VALUES ('p','Fixture','/fixture','main','{}',1,1)");
    raw.exec("INSERT INTO threads (id,project_id,title,agent,mode,permission_mode,created_at,updated_at,last_activity_at) VALUES ('t','p','Old','claude','plan','review',1,1,1)");
    raw.exec("INSERT INTO runs (id,thread_id,agent,mode,permission_mode,state,started_at) VALUES ('r','t','claude','plan','review','success',1)");
    raw.exec(
      "INSERT INTO schedules (id,project_id,title,prompt,agent,mode,permission_mode,workspace_mode,every_minutes,next_run_at,created_at,updated_at) VALUES ('s','p','Old','Review','claude','plan','review','current',60,1,1,1)",
    );
    raw.close();
    const db = Db.open(file);
    expect(threads.get(db, "t")?.claudeAccountId).toBe("claude-cli");
    expect(runs.get(db, "r")?.claudeAccountId).toBe("claude-cli");
    expect(schedules.get(db, "s")?.claudeAccountId).toBe("claude-cli");
    expect(db.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
