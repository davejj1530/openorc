import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TEAM_LIMITS, type TeamExecutionRecord } from "@openorc/protocol";
import { Db } from "./database.js";
import { orchestration } from "./orchestration.js";
import { projects, threads } from "./repos.js";
import { teamRuntime } from "./team-runtime.js";
import { teamNotifications } from "./team-notifications.js";

const opened: Db[] = [],
  directories: string[] = [];
afterEach(() => {
  opened.splice(0).forEach((db) => db.close());
  directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
function execution(db: Db): TeamExecutionRecord {
  const settings = { agent: "codex" as const, model: "fixture", effort: null, fastMode: false };
  const project = projects.insert(db, { name: "Notice", rootPath: `/tmp/${randomUUID()}`, gitRemote: null, defaultBranch: "main", settings: {} });
  const thread = threads.insert(db, { projectId: project.id, title: "Notice", ...settings, mode: "act", permissionMode: "trusted" });
  const team = orchestration.save(db, {
    projectId: project.id,
    expectedRevisionId: null,
    draft: { name: "Team", limits: DEFAULT_TEAM_LIMITS, members: [{ key: "lead", name: "Lead", managerKey: null, responsibility: "Work", settings }] },
  });
  const instance = orchestration.createInstance(db, { threadId: thread.id, teamRevisionId: team.revision.id });
  return teamRuntime.create(db, {
    id: randomUUID(),
    threadId: thread.id,
    projectId: project.id,
    instanceId: instance.id,
    state: "active",
    generation: 1,
    revision: 0,
    limits: DEFAULT_TEAM_LIMITS,
    actors: [
      {
        id: "lead",
        memberKey: "lead",
        taskId: null,
        parentId: null,
        requestKey: null,
        requestHash: null,
        dependencies: [],
        input: { title: "Work", spec: "Work", attachments: [], responsibility: "Work", settings },
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
}
describe("durable team notification receipts", () => {
  it("claims once, rejects cross-execution identity reuse, and rolls back with the caller", () => {
    const db = Db.memory();
    opened.push(db);
    const first = execution(db),
      second = execution(db);
    expect(teamNotifications.claim(db, { id: "notice", executionId: first.id, createdAt: 10 })).toBe(true);
    expect(teamNotifications.claim(db, { id: "notice", executionId: first.id, createdAt: 20 })).toBe(false);
    expect(() => teamNotifications.claim(db, { id: "notice", executionId: second.id, createdAt: 10 })).toThrow(/another execution/);
    expect(() => teamNotifications.claim(db, { id: "unknown", executionId: "missing", createdAt: 10 })).toThrow(/not found/);
    expect(() =>
      db.transaction(() => {
        teamNotifications.claim(db, { id: "rolled-back", executionId: first.id, createdAt: 10 });
        throw Error("rollback");
      }),
    ).toThrow("rollback");
    expect(teamNotifications.has(db, "rolled-back")).toBe(false);
    expect(db.stmt("SELECT created_at FROM team_notification_receipts WHERE id='notice'").get()).toEqual({ created_at: 10 });
  });
  it("survives database reopen and cascades only with its owning execution", () => {
    const dir = mkdtempSync(join(tmpdir(), "openorc-notices-"));
    directories.push(dir);
    const file = join(dir, "fixture.sqlite");
    const db = Db.open(file);
    const record = execution(db);
    teamNotifications.claim(db, { id: "retained", executionId: record.id, createdAt: 10 });
    db.close();
    const reopened = Db.open(file);
    opened.push(reopened);
    expect(teamNotifications.claim(reopened, { id: "retained", executionId: record.id, createdAt: 20 })).toBe(false);
    threads.delete(reopened, record.threadId);
    expect(teamNotifications.has(reopened, "retained")).toBe(false);
    expect(reopened.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
