import { gunzipSync, gzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { decodePackage, encodePackage, RelocationRefused, type RelocationPackage } from "./relocation-package.js";

const MAGIC = Buffer.from("OPENORC-THREAD-1\n");

function packageWith(tasks: number): RelocationPackage {
  return {
    v: 1,
    relocation: "r1",
    from: "mac",
    macProject: "p1",
    rows: { v: 1, threadId: "t1", tables: { threads: [{ id: "t1" }], tasks: Array.from({ length: tasks }, (_, index) => ({ id: `task-${index}` })) } as never, search: [] },
    dataDir: "/data",
    worktree: "/data/worktrees/t1",
    files: [],
    session: null,
    code: { branch: "openorc/t1", head: "a".repeat(40), work: null, checkpoints: [`refs/openorc/snapshots/task-0/${"b".repeat(40)}`], bundle: Buffer.from("bundle") },
  };
}

/** The header as a reader sees it, and the package with the header replaced. */
function header(bytes: Buffer): Record<string, unknown> {
  const length = Number(bytes.readBigUInt64BE(MAGIC.length));
  return JSON.parse(gunzipSync(bytes.subarray(MAGIC.length + 8, MAGIC.length + 8 + length)).toString("utf8")) as Record<string, unknown>;
}
function withHeader(bytes: Buffer, next: Record<string, unknown>): Buffer {
  const length = Number(bytes.readBigUInt64BE(MAGIC.length));
  const json = gzipSync(Buffer.from(JSON.stringify(next)));
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(json.length));
  return Buffer.concat([MAGIC, size, json, bytes.subarray(MAGIC.length + 8 + length)]);
}

it("names how many tasks travel, which a brain from before refuses as an unknown field instead of dropping them", () => {
  const bytes = encodePackage(packageWith(2));
  expect(header(bytes)["tasks"]).toBe(2);
  expect(decodePackage(bytes).rows.tables.tasks).toHaveLength(2);
  expect(decodePackage(bytes)).not.toHaveProperty("tasks");
  expect(() => decodePackage(withHeader(bytes, { ...header(bytes), tasks: 1 }))).toThrow(RelocationRefused);
  // A thread with no tasks reads as packages always did.
  expect(header(encodePackage(packageWith(0)))).not.toHaveProperty("tasks");
});

it("refuses a package naming a session that is not a plain name, in its header or on a run, since it becomes a file name", () => {
  const traversal = "../-Users-me-dev-other/2f1c-victim-session";
  const session = { agent: "claude" as const, accountId: "work", sessionId: "0b9f3c3e-5d2a-4f1e-9c47-2a6f0d8e1b55", text: "" };
  const plain = packageWith(0);
  expect(decodePackage(encodePackage({ ...plain, session })).session?.sessionId).toBe(session.sessionId);
  expect(() => decodePackage(encodePackage({ ...plain, session: { ...session, sessionId: traversal } }))).toThrow(RelocationRefused);
  const run = (id: string | null) => ({ ...plain, rows: { ...plain.rows, tables: { ...plain.rows.tables, runs: [{ id: "run-1", external_session_id: id }] } } as never });
  expect(decodePackage(encodePackage(run(null))).rows.tables.runs).toHaveLength(1);
  expect(decodePackage(encodePackage(run(session.sessionId))).rows.tables.runs).toHaveLength(1);
  expect(() => decodePackage(encodePackage(run(traversal)))).toThrow(RelocationRefused);
});
