import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@openorc/protocol";
import { Db } from "./database.js";
import { LedgerWriter, listEvents } from "./ledger.js";
import { ledgerMaintenance } from "./maintenance.js";
import { projects, runs, threads } from "./repos.js";

let dir: string;
let db: Db;
let runId: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "openorc-maintenance-"));
  db = Db.open(path.join(dir, "ledger.sqlite"));
  const project = projects.insert(db, { name: "demo", rootPath: "/tmp/demo", gitRemote: null, defaultBranch: "main", settings: {} });
  const thread = threads.insert(db, { projectId: project.id, title: "t", agent: "claude", model: null, mode: "act", permissionMode: "trusted" });
  runId = runs.insert(db, { id: "run-1", taskId: null, threadId: thread.id, agent: "claude", model: null, mode: "act", permissionMode: "trusted" }).id;
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

function write(events: AgentEvent[]): void {
  const writer = new LedgerWriter(db, { flushMs: 1_000_000, maxBatch: 1_000_000, artifactThresholdBytes: 1024 });
  for (const ev of events) writer.push(ev);
  writer.flush();
}
const raw = (ts: number, bytes = 10): AgentEvent => ({ type: "raw", runId, ts, agent: "claude", payload: { text: "r".repeat(bytes) } });
const artifactCount = () => (db.raw.prepare("SELECT COUNT(*) AS c FROM artifacts").get() as { c: number }).c;

describe("ledgerMaintenance", () => {
  it("expires raw rows older than the cutoff in bounded batches, payloads included, and nothing else", () => {
    write([raw(1, 4000), raw(2), raw(3), raw(100), { type: "message.completed", runId, ts: 1, messageId: "m", role: "assistant", text: "kept" }]);
    expect(artifactCount()).toBe(1);
    expect(ledgerMaintenance.expireRaw(db, 50, 2)).toBe(2);
    expect(ledgerMaintenance.expireRaw(db, 50, 2)).toBe(1);
    expect(ledgerMaintenance.expireRaw(db, 50, 2)).toBe(0);
    // Written order: the recent raw row came before the message.
    expect(listEvents(db, runId, { includeRaw: true }).map((ev) => [ev.type, ev.ts])).toEqual([
      ["raw", 100],
      ["message.completed", 1],
    ]);
    expect(artifactCount()).toBe(0);
  });

  it("compacts once into incremental mode, then hands later free space back in steps", () => {
    expect(ledgerMaintenance.space(db).incremental).toBe(true);
    // A file made before new ledgers started out incremental.
    db.raw.exec("PRAGMA auto_vacuum = NONE");
    db.raw.exec("VACUUM");
    write(Array.from({ length: 400 }, (_, i) => raw(i, 5000)));
    expect(ledgerMaintenance.space(db).incremental).toBe(false);
    while (ledgerMaintenance.expireRaw(db, 200) > 0);
    const beforeCompact = ledgerMaintenance.space(db);
    expect(beforeCompact.freeBytes).toBeGreaterThan(0);
    ledgerMaintenance.compact(db);
    const compacted = ledgerMaintenance.space(db);
    expect(compacted).toMatchObject({ incremental: true, freeBytes: 0 });
    expect(compacted.fileBytes).toBeLessThan(beforeCompact.fileBytes);
    while (ledgerMaintenance.expireRaw(db, 400) > 0);
    const freed = ledgerMaintenance.space(db).freeBytes;
    expect(freed).toBeGreaterThan(0);
    expect(ledgerMaintenance.reclaim(db, 10)).toBe(10);
    expect(ledgerMaintenance.space(db).freeBytes).toBe(freed - 10 * 4096);
  });

  it("clears streamed rows already replaced in history, keeping each item's first row and reading large rows from their artifacts", () => {
    // A writer per row stores every row, as history did before the writer settled them live.
    for (const ev of [
      { type: "message.delta", runId, ts: 1, messageId: "big", role: "assistant", text: "a" },
      { type: "tool.started", runId, ts: 2, toolCallId: "c-out", name: "Bash", input: {} },
      { type: "message.delta", runId, ts: 3, messageId: "big", role: "assistant", text: "b".repeat(2000) },
      { type: "message.delta", runId, ts: 4, messageId: "open", role: "assistant", text: "b" },
      { type: "message.delta", runId, ts: 5, messageId: "open", role: "assistant", text: "c" },
      { type: "thinking.delta", runId, ts: 6, messageId: "t-empty", text: "kept" },
      { type: "thinking.delta", runId, ts: 7, messageId: "t-empty", text: "kept too" },
      { type: "tool.output.delta", runId, ts: 8, toolCallId: "c-null", text: "kept" },
      { type: "tool.output.delta", runId, ts: 9, toolCallId: "c-null", text: "kept too" },
      { type: "tool.output.delta", runId, ts: 10, toolCallId: "c-out", text: "first" },
      { type: "tool.output.delta", runId, ts: 11, toolCallId: "c-out", text: "gone" },
      { type: "activity.updated", runId, ts: 12, activityId: "diff-1", label: "Changes", status: "running", text: "v1" },
      { type: "activity.updated", runId, ts: 13, activityId: "diff-1", label: "Changes", status: "running", text: "v2" },
      { type: "activity.updated", runId, ts: 14, activityId: "diff-1", label: "Changes", status: "running", text: "v3", detail: { kept: true } },
      { type: "activity.updated", runId, ts: 15, activityId: "diff-1", label: "Changes", status: "running", text: "v4" },
      { type: "activity.updated", runId, ts: 16, activityId: "diff-1", label: "Changes", status: "success" },
      { type: "message.completed", runId, ts: 17, messageId: "big", role: "assistant", text: "x".repeat(5000) },
      { type: "thinking.completed", runId, ts: 18, messageId: "t-empty", text: "" },
      { type: "tool.completed", runId, ts: 19, toolCallId: "c-null", name: "Bash", output: null, isError: false },
      { type: "tool.completed", runId, ts: 20, toolCallId: "c-out", name: "Bash", output: "done", isError: false },
    ] as AgentEvent[]) {
      const writer = new LedgerWriter(db, { artifactThresholdBytes: 1024 });
      writer.push(ev);
      writer.flush();
    }
    expect(artifactCount()).toBe(2);
    // Gone: the large message fragment (stored as an artifact), the tool's later fragment, and a diff snapshot a later one replaced.
    expect(ledgerMaintenance.clearSupersededFragments(db, runId)).toBe(3);
    expect(artifactCount()).toBe(1);
    expect(listEvents(db, runId).map((ev) => ev.ts)).toEqual([1, 2, 4, 5, 6, 7, 8, 9, 10, 12, 14, 15, 16, 17, 18, 19, 20]);
  });
});
