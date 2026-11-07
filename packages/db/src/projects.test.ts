import { afterEach, expect, it } from "vitest";
import { Db } from "./database.js";
import { projects, threads } from "./repos.js";

const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
function fixture() {
  const db = Db.memory();
  opened.push(db);
  return db;
}
const selection = { only: true, accountIds: ["work", "personal"], defaultId: "work", autoSwitch: true };

it("reads a project saved before it had Claude accounts as following the app's", () => {
  const db = fixture();
  const project = projects.insert(db, { name: "Legacy", rootPath: "/tmp/legacy-project", gitRemote: null, defaultBranch: "main", settings: {} });
  // A row an older app wrote: no claudeAccounts key at all.
  db.stmt("UPDATE projects SET settings = ? WHERE id = ?").run(JSON.stringify({ setupScript: null, worktreeInclude: [".env"], branchPrefix: "legacy", detectedConfigs: [] }), project.id);
  expect(projects.get(db, project.id)?.settings).toEqual({ setupScript: null, worktreeInclude: [".env"], branchPrefix: "legacy", detectedConfigs: [], claudeAccounts: null });
});

it("keeps a project's Claude accounts when other settings are saved, as an older app saves them", () => {
  const db = fixture();
  const project = projects.insert(db, { name: "Accounts", rootPath: "/tmp/accounts-project", gitRemote: null, defaultBranch: "main", settings: {} });
  projects.updateSettings(db, project.id, { claudeAccounts: selection });
  const saved = projects.updateSettings(db, project.id, { branchPrefix: "feature", worktreeInclude: [], setupScript: null });
  expect(saved.settings).toMatchObject({ branchPrefix: "feature", claudeAccounts: selection });
  // Turning the override off keeps the selection for turning it back on.
  const off = projects.updateSettings(db, project.id, { claudeAccounts: { ...selection, only: false } });
  expect(off.settings.claudeAccounts).toEqual({ ...selection, only: false });
  expect(projects.get(db, project.id)?.settings.claudeAccounts).toEqual({ ...selection, only: false });
});

it("leaves a project's place in the list when only its Claude accounts change, and moves it up for other settings", () => {
  const db = fixture();
  const first = projects.insert(db, { name: "First", rootPath: "/tmp/first-project", gitRemote: null, defaultBranch: "main", settings: {} });
  const second = projects.insert(db, { name: "Second", rootPath: "/tmp/second-project", gitRemote: null, defaultBranch: "main", settings: {} });
  db.stmt("UPDATE projects SET updated_at = ? WHERE id = ?").run(1, first.id);
  db.stmt("UPDATE projects SET updated_at = ? WHERE id = ?").run(2, second.id);
  const order = () => projects.list(db).map((project) => project.name);
  expect(order()).toEqual(["Second", "First"]);
  expect(projects.updateSettings(db, first.id, { claudeAccounts: selection }).updatedAt).toBe(1);
  expect(order()).toEqual(["Second", "First"]);
  projects.updateSettings(db, first.id, { branchPrefix: "feature" });
  expect(order()).toEqual(["First", "Second"]);
});

it("orders projects by their threads' last activity, and puts projects without threads after them", () => {
  const db = fixture();
  const insert = (name: string) => projects.insert(db, { name, rootPath: `/tmp/${name}-project`, gitRemote: null, defaultBranch: "main", settings: {} });
  const older = insert("Older");
  const newer = insert("Newer");
  const empty = insert("Empty");
  const active = (projectId: string, at: number) => {
    const thread = threads.insert(db, { projectId, title: "Work", agent: "claude", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "current" });
    db.stmt("UPDATE threads SET last_activity_at = ? WHERE id = ?").run(at, thread.id);
  };
  active(older.id, 1);
  active(newer.id, 2);
  // Edited after every thread's activity, still behind the projects that have threads.
  db.stmt("UPDATE projects SET updated_at = ? WHERE id = ?").run(10, empty.id);
  const order = () => projects.list(db).map((project) => project.name);
  expect(order()).toEqual(["Newer", "Older", "Empty"]);
  active(older.id, 3);
  expect(order()).toEqual(["Older", "Newer", "Empty"]);
});
