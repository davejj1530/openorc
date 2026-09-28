import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db, ledgerMaintenance, listEvents, projects, runs, settings, threads } from "@openorc/db";
import type { AgentEvent } from "@openorc/protocol";
import { LedgerUpkeep } from "./ledger-upkeep.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY_MS;

let dir: string;
let file: string;
let db: Db;
let threadId: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "openorc-upkeep-"));
  file = path.join(dir, "openorc.sqlite");
  db = Db.open(file);
  const project = projects.insert(db, { name: "demo", rootPath: "/tmp/demo", gitRemote: null, defaultBranch: "main", settings: {} });
  threadId = threads.insert(db, { projectId: project.id, title: "t", agent: "claude", model: null, mode: "act", permissionMode: "trusted" }).id;
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const log = { info: () => undefined, warn: (message: string) => expect.fail(message), error: (message: string) => expect.fail(message) };
const upkeep = () => new LedgerUpkeep(db, { log, pause: () => Promise.resolve(), now: () => NOW });

function run(id: string, state: string): string {
  runs.insert(db, { id, taskId: null, threadId, agent: "claude", model: null, mode: "act", permissionMode: "trusted" });
  db.stmt("UPDATE runs SET state = ? WHERE id = ?").run(state, id);
  return id;
}

/** Rows as history written before the ledger kept native rows and fragments out of it. */
function insert(runId: string, events: AgentEvent[]): void {
  const seq = (db.stmt("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE run_id = ?").get(runId) as { seq: number }).seq;
  events.forEach((ev, i) => {
    const payload = JSON.stringify(ev);
    db.stmt("INSERT INTO events (run_id, seq, ts, kind, payload, payload_sha256, bytes) VALUES (?, ?, ?, ?, ?, '', ?)").run(runId, seq + i + 1, ev.ts, ev.type, payload, payload.length);
  });
}

const kinds = (runId: string) => listEvents(db, runId, { includeRaw: true }).map((ev) => ev.type);

describe("LedgerUpkeep", () => {
  it("clears fragments from ended runs once, leaving open runs to the live writer", async () => {
    const fragments = (runId: string): AgentEvent[] => [
      { type: "message.delta", runId, ts: 1, messageId: "m", role: "assistant", text: "he" },
      { type: "message.delta", runId, ts: 2, messageId: "m", role: "assistant", text: "llo" },
      { type: "message.completed", runId, ts: 3, messageId: "m", role: "assistant", text: "hello" },
    ];
    const ended = run("r1", "success");
    const open = run("r2", "running");
    insert(ended, fragments(ended));
    insert(open, fragments(open));
    await upkeep().run();
    expect(kinds(ended)).toEqual(["message.delta", "message.completed"]);
    expect(kinds(open)).toEqual(["message.delta", "message.delta", "message.completed"]);
    expect(settings.get(db, "ledger.fragmentSweep")).toBe("done");

    // Done means done: later history is the live writer's to settle.
    insert(ended, fragments(ended));
    await upkeep().run();
    expect(kinds(ended)).toEqual(["message.delta", "message.completed", "message.delta", "message.delta", "message.completed"]);
  });

  it("resumes the fragment sweep after the last run it finished", async () => {
    const first = run("r1", "success");
    const second = run("r2", "success");
    db.stmt("UPDATE runs SET started_at = ? WHERE id = ?").run(1, first);
    db.stmt("UPDATE runs SET started_at = ? WHERE id = ?").run(2, second);
    for (const id of [first, second]) {
      insert(id, [
        { type: "message.delta", runId: id, ts: 1, messageId: "m", role: "assistant", text: "h" },
        { type: "message.delta", runId: id, ts: 2, messageId: "m", role: "assistant", text: "i" },
        { type: "message.completed", runId: id, ts: 3, messageId: "m", role: "assistant", text: "hi" },
      ]);
    }
    settings.set(db, "ledger.fragmentSweep", JSON.stringify({ startedAt: 1, id: first }));
    await upkeep().run();
    expect(kinds(first)).toEqual(["message.delta", "message.delta", "message.completed"]);
    expect(kinds(second)).toEqual(["message.delta", "message.completed"]);
  });

  it("hands free space back to the disk once the file is incremental", async () => {
    const id = run("r1", "success");
    insert(
      id,
      Array.from({ length: 300 }, (_, i) => ({ type: "raw", runId: id, ts: 0, agent: "claude", payload: { i, text: "x".repeat(8000) } }) as AgentEvent),
    );
    const before = ledgerMaintenance.space(db);
    expect(before.incremental).toBe(true);
    await upkeep().run();
    const after = ledgerMaintenance.space(db);
    expect(after.freeBytes).toBe(0);
    // The 300 payloads came to about 2.4 MB.
    expect(before.fileBytes - after.fileBytes).toBeGreaterThan(2 * 1024 * 1024);
  });

  it("compacts a file made before incremental vacuuming on a second connection, which the open one keeps using", async () => {
    db.raw.exec("PRAGMA auto_vacuum = NONE");
    db.raw.exec("VACUUM");
    const id = run("r1", "success");
    insert(
      id,
      Array.from({ length: 300 }, (_, i) => ({ type: "raw", runId: id, ts: 0, agent: "claude", payload: { i, text: "x".repeat(8000) } }) as AgentEvent),
    );
    while (ledgerMaintenance.expireRaw(db, 1) > 0);
    const before = ledgerMaintenance.space(db);
    expect(before.incremental).toBe(false);
    await LedgerUpkeep.compact(db, file);
    const after = ledgerMaintenance.space(db);
    expect(after).toMatchObject({ incremental: true, freeBytes: 0 });
    // The 300 payloads came to about 2.4 MB.
    expect(before.fileBytes - after.fileBytes).toBeGreaterThan(2 * 1024 * 1024);
    expect(runs.get(db, id)?.state).toBe("success");
  });

  it("needs no compaction for a file created incremental", () => {
    expect(ledgerMaintenance.space(db).incremental).toBe(true);
    expect(LedgerUpkeep.needsCompaction(db, dir)).toBe(false);
  });

  it("remembers a failed compaction and skips it for a few days", async () => {
    await expect(LedgerUpkeep.compact(db, path.join(dir, "missing", "ledger.sqlite"))).rejects.toThrow();
    expect(Number(settings.get(db, "ledger.compactionFailedAt"))).toBeGreaterThan(0);
  });
});
