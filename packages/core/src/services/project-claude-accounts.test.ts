import { claudeAccounts, Db, projects } from "@openorc/db";
import { DEFAULT_CLAUDE_ACCOUNT, WORKSPACE_ID, type Project, type ProjectClaudeAccounts } from "@openorc/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowsAccount, NO_PROJECT_ACCOUNTS, projectAccountPolicy, startingAccount } from "./project-claude-accounts.js";
import { ProjectService } from "./projects.js";

let db: Db;
let project: Project;
let work: string;
let personal: string;
let client: string;

beforeEach(() => {
  db = Db.memory();
  project = projects.insert(db, { name: "Fixture", rootPath: "/tmp/project-accounts-fixture", gitRemote: null, defaultBranch: "main", settings: {} });
  // Apart in time, so the app lists them in this order.
  vi.useFakeTimers({ toFake: ["Date"] });
  [work, personal, client] = ["Work", "Personal", "Client"].map((name, index) => {
    vi.setSystemTime(1_000 + index);
    return claudeAccounts.add(db, name).id;
  }) as [string, string, string];
  vi.useRealTimers();
});
afterEach(() => db.close());

const own = (patch: Partial<ProjectClaudeAccounts> = {}): ProjectClaudeAccounts => ({ only: true, accountIds: [work, personal], defaultId: personal, autoSwitch: true, ...patch });
const choose = (claudeAccounts: ProjectClaudeAccounts | null) => projects.updateSettings(db, project.id, { claudeAccounts });

describe("projectAccountPolicy", () => {
  it("follows the app's accounts, default and switch for a project without its own, one that turned them off, and the Workspace", () => {
    claudeAccounts.update(db, { id: client, makeDefault: true });
    const app = { restricted: false, allowed: [DEFAULT_CLAUDE_ACCOUNT, work, personal, client], defaultId: client, autoSwitch: true };
    expect(projectAccountPolicy(db, project.id, { claudeAccountAutoSwitch: true })).toEqual(app);
    choose(own({ only: false, autoSwitch: false }));
    expect(projectAccountPolicy(db, project.id, { claudeAccountAutoSwitch: true })).toEqual(app);
    expect(projectAccountPolicy(db, WORKSPACE_ID, { claudeAccountAutoSwitch: false })).toEqual({ ...app, autoSwitch: false });
    expect(projectAccountPolicy(db, "missing-project", { claudeAccountAutoSwitch: false }).restricted).toBe(false);
  });

  it("allows only the project's enabled accounts, in the app's order, with its own default and switch", () => {
    choose(own({ accountIds: [personal, work], autoSwitch: false }));
    expect(projectAccountPolicy(db, project.id, { claudeAccountAutoSwitch: true })).toEqual({ restricted: true, allowed: [work, personal], defaultId: personal, autoSwitch: false });
  });

  it("drops disabled and removed accounts as it reads, without rewriting the selection, and falls back to the first allowed", () => {
    choose(own({ accountIds: [work, personal, "gone"], defaultId: personal }));
    claudeAccounts.update(db, { id: personal, enabled: false });
    expect(projectAccountPolicy(db, project.id)).toMatchObject({ restricted: true, allowed: [work], defaultId: work });
    expect(projects.get(db, project.id)?.settings.claudeAccounts?.accountIds).toEqual([work, personal, "gone"]);
    claudeAccounts.update(db, { id: personal, enabled: true });
    expect(projectAccountPolicy(db, project.id)).toMatchObject({ allowed: [work, personal], defaultId: personal });
  });

  it("allows nothing when none of the project's accounts is usable, and new starts say so", () => {
    choose(own({ accountIds: [work], defaultId: work }));
    claudeAccounts.update(db, { id: work, enabled: false });
    const policy = projectAccountPolicy(db, project.id);
    expect(policy).toMatchObject({ restricted: true, allowed: [] });
    expect(allowsAccount(policy, work)).toBe(false);
    expect(() => startingAccount(db, project.id, undefined)).toThrow(NO_PROJECT_ACCOUNTS);
    expect(() => startingAccount(db, project.id, client)).toThrow(NO_PROJECT_ACCOUNTS);
    expect(() => startingAccount(db, project.id, work, "inherited")).toThrow(NO_PROJECT_ACCOUNTS);
    // A thread that is not Claude's still starts, its account only carried along.
    expect([startingAccount(db, project.id, undefined, "unused"), startingAccount(db, project.id, work, "unused")]).toEqual([DEFAULT_CLAUDE_ACCOUNT, DEFAULT_CLAUDE_ACCOUNT]);
  });
});

describe("startingAccount", () => {
  it("starts where it was asked, or on the app's default, in a project that follows the app's", () => {
    expect(startingAccount(db, project.id, undefined)).toBe(DEFAULT_CLAUDE_ACCOUNT);
    expect(startingAccount(db, project.id, client)).toBe(client);
  });

  it("refuses an account a person chose that the project does not use, and replaces one passed down", () => {
    choose(own());
    expect(startingAccount(db, project.id, undefined)).toBe(personal);
    expect(startingAccount(db, project.id, work)).toBe(work);
    expect(() => startingAccount(db, project.id, client)).toThrow("This project only uses these Claude accounts: Work, Personal.");
    expect(startingAccount(db, project.id, client, "inherited")).toBe(personal);
    expect(startingAccount(db, project.id, client, "own")).toBe(client);
  });
});

describe("ProjectService.updateSettings", () => {
  it("refuses a selection that could not work, and the Workspace", () => {
    const service = new ProjectService(db);
    const save =
      (claudeAccounts: ProjectClaudeAccounts, id = project.id) =>
      () =>
        service.updateSettings(id, { claudeAccounts });
    expect(save(own({ accountIds: [], defaultId: null }))).toThrow("Choose at least one Claude account for this project.");
    expect(save(own({ accountIds: [work, "gone"] }))).toThrow(/no longer available/);
    expect(save(own({ defaultId: client }))).toThrow(/default Claude account/);
    expect(save(own({ defaultId: null }))).toThrow(/default Claude account/);
    expect(save(own(), WORKSPACE_ID)).toThrow("The Workspace uses the app's Claude accounts.");
    expect(projects.get(db, project.id)?.settings.claudeAccounts).toBeNull();
    // Turned off, nothing is checked: the selection is only kept for later.
    expect(service.updateSettings(project.id, { claudeAccounts: own({ only: false, accountIds: [], defaultId: null }) }).settings.claudeAccounts?.only).toBe(false);
  });

  it("saves a selection once, records it, and keeps it when an older app saves its worktree settings", () => {
    const service = new ProjectService(db);
    service.updateSettings(project.id, { claudeAccounts: own({ accountIds: [work, personal, work] }) });
    expect(projects.get(db, project.id)?.settings.claudeAccounts).toEqual(own());
    expect(db.stmt("SELECT action FROM audit_events WHERE resource_id = ?").all(project.id)).toContainEqual({ action: "project.settings" });
    service.updateSettings(project.id, { branchPrefix: "older", worktreeInclude: [".env"], setupScript: null });
    expect(projects.get(db, project.id)?.settings).toMatchObject({ branchPrefix: "older", claudeAccounts: own() });
  });
});
