import { afterEach, expect, it } from "vitest";
import { constants, DatabaseSync } from "node:sqlite";
import { UsageHistoryParams, type HarnessId, type Usage } from "@openorc/protocol";
import { Db } from "./database.js";
import { LedgerWriter } from "./ledger.js";
import { projects, runs, tasks, threads } from "./repos.js";
import { subagents } from "./subagents.js";
import { usageHistory } from "./usage-history.js";
import { migrations } from "./schema.js";
import { usageHistoryMigration } from "./usage-history-schema.js";

const databases: Db[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture(db = Db.memory()) {
  databases.push(db);
  const project = projects.insert(db, { name: "Example", rootPath: "/tmp/usage-example", gitRemote: null, defaultBranch: "main", settings: {} });
  const task = tasks.insert(db, { projectId: project.id, title: "Example work", spec: null, priority: "none", labels: [], workspaceMode: "worktree", baseRef: null, parentTaskId: null });
  const writer = new LedgerWriter(db, { artifactThresholdBytes: 500 });
  function run(id: string, agent: HarnessId, session = id, model = "example-model") {
    runs.insert(db, { id, taskId: task.id, threadId: null, agent, model, mode: "act", permissionMode: "trusted" });
    runs.update(db, id, { externalSessionId: session });
  }
  function turn(runId: string, ts: number, usage?: Usage, resultText?: string) {
    writer.push({ type: "turn.completed", runId, ts, turnId: `turn-${ts}`, status: "success", durationMs: 1, ...(usage ? { usage } : {}), ...(resultText ? { resultText } : {}) });
    writer.flush();
  }
  function update(runId: string, ts: number, usage: Usage) {
    writer.push({ type: "usage.updated", runId, ts, usage });
    writer.flush();
  }
  return { db, run, turn, update, project };
}

it("attributes resumed session cost to the right day and adds prompt tokens only once", () => {
  const f = fixture();
  f.run("first", "claude", "shared");
  f.turn("first", 5, { inputTokens: 500, outputTokens: 80, costUsd: 10 });
  f.turn("first", 12, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 800, costUsd: 12 });
  f.run("resumed", "claude", "shared");
  f.turn("resumed", 22, { inputTokens: 200, outputTokens: 40, cacheWriteTokens: 50, costUsd: 15 });
  f.turn("resumed", 30, { inputTokens: 999, outputTokens: 999, costUsd: 100 });
  const result = usageHistory(f.db, { boundaries: [10, 20, 30] });
  expect(result.total).toEqual({ costUsd: 5, inputTokens: 300, outputTokens: 60, cacheReadTokens: 800, cacheWriteTokens: 50, sessions: 1, unpricedSessions: 0, unreportedTokenSessions: 0 });
  expect(result.buckets.map((bucket) => bucket.total.costUsd)).toEqual([2, 3]);
  expect(result.models).toHaveLength(1);
});

it("subtracts Codex session counters and separates cached input from total input", () => {
  const f = fixture();
  f.run("codex-first", "codex", "shared");
  f.update("codex-first", 5, { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 600 });
  f.run("codex-resumed", "codex", "shared");
  const usage = { inputTokens: 1300, outputTokens: 140, cacheReadTokens: 800 };
  f.update("codex-resumed", 15, usage);
  f.update("codex-resumed", 16, usage);
  f.turn("codex-resumed", 17, usage);
  const result = usageHistory(f.db, { boundaries: [10, 20, 30] });
  expect(result.total).toEqual({ costUsd: null, inputTokens: 100, outputTokens: 40, cacheReadTokens: 200, cacheWriteTokens: 0, sessions: 1, unpricedSessions: 1, unreportedTokenSessions: 0 });
  expect(result.buckets[1]?.total).toMatchObject({ costUsd: 0, sessions: 0, inputTokens: 0 });
});

it("estimates recorded Codex history once, with cached input discounted and earlier usage excluded", () => {
  const f = fixture();
  f.run("first", "codex", "shared", "gpt-6.1-sol");
  f.update("first", 5, { inputTokens: 1_000_000, cacheReadTokens: 800_000, outputTokens: 20_000 });
  f.run("resumed", "codex", "shared", "gpt-6.1-sol");
  const usage = { inputTokens: 2_000_000, cacheReadTokens: 1_600_000, outputTokens: 40_000 };
  f.update("resumed", 12, usage);
  f.update("resumed", 13, usage);
  f.turn("resumed", 14, usage);
  const result = usageHistory(f.db, { boundaries: [10, 20, 30] });
  expect(result.total).toMatchObject({ costUsd: 0.68, sessions: 1, unpricedSessions: 0, inputTokens: 200_000, cacheReadTokens: 800_000 });
  expect(result.agents[0]?.costUsd).toBe(0.68);
  expect(result.models[0]?.costUsd).toBe(0.68);
  expect(result.buckets.map((bucket) => bucket.total.costUsd)).toEqual([0.68, 0]);
});

it("uses the model and speed recorded with each report when a live session changes settings", () => {
  const f = fixture();
  f.run("changing", "codex", "shared", "gpt-6-astra");
  runs.update(f.db, "changing", { fastMode: true });
  f.update("changing", 12, { model: "gpt-6.1-sol", fastMode: false, inputTokens: 100_000, outputTokens: 10_000 });
  f.update("changing", 22, { model: "gpt-6-astra", fastMode: true, inputTokens: 200_000, outputTokens: 20_000 });
  const result = usageHistory(f.db, { boundaries: [10, 20, 30] });
  expect(result.total.costUsd).toBeCloseTo(3.3);
  expect(result.models.map((row) => [row.model, row.costUsd])).toEqual([
    ["gpt-6.1-sol", 0.3],
    ["gpt-6-astra", 3],
  ]);
});

it("preserves an explicit provider cost, including zero, instead of adding an estimate", () => {
  const f = fixture();
  f.run("reported", "codex", "reported", "gpt-6.1-sol");
  f.turn("reported", 12, { inputTokens: 100_000, outputTokens: 10_000, costUsd: 0 });
  f.turn("reported", 22, { inputTokens: 200_000, outputTokens: 20_000, costUsd: 0.8 });
  const result = usageHistory(f.db, { boundaries: [10, 20, 30] });
  expect(result.total).toMatchObject({ costUsd: 0.8, unpricedSessions: 0 });
  expect(result.buckets.map((bucket) => bucket.total.costUsd)).toEqual([0, 0.8]);
});

it("counts Pi session totals once, keeps a reported zero price, and filters agents", () => {
  const f = fixture();
  f.run("pi", "pi");
  f.update("pi", 12, { inputTokens: 100, outputTokens: 10, costUsd: 0 });
  f.turn("pi", 13, { inputTokens: 100, outputTokens: 10, costUsd: 0 });
  f.turn("pi", 22, { inputTokens: 150, outputTokens: 20, costUsd: 0 });
  f.run("unpriced", "codex");
  f.turn("unpriced", 15);
  const result = usageHistory(f.db, { boundaries: [10, 30] });
  expect(result.total).toMatchObject({ costUsd: 0, inputTokens: 150, outputTokens: 20, sessions: 2, unpricedSessions: 1 });
  expect(usageHistory(f.db, { boundaries: [10, 30], agent: "pi" }).total).toMatchObject({ sessions: 1, unpricedSessions: 0 });
});

it("reads accounting stored with a large completion artifact and counts ACP prompt tokens", () => {
  const f = fixture();
  f.run("opencode", "opencode");
  f.update("opencode", 11, { inputTokens: 30, outputTokens: 5, costUsd: 0.2 });
  f.turn("opencode", 12, { inputTokens: 30, outputTokens: 5, costUsd: 0.2 }, "A complete response. ".repeat(100));
  f.turn("opencode", 22, { inputTokens: 20, outputTokens: 4, costUsd: 0.5 });
  expect(usageHistory(f.db, { boundaries: [10, 20, 30] }).total).toMatchObject({ inputTokens: 50, outputTokens: 9, costUsd: 0.5, sessions: 1 });
});

it("loads usage without reading transcript events or their large artifact payloads", () => {
  const f = fixture();
  f.run("accounting", "claude");
  f.turn("accounting", 12, { inputTokens: 30, outputTokens: 5, costUsd: 0.2 }, "A complete response. ".repeat(100));
  f.db.raw.setAuthorizer((action, table) => (action === constants.SQLITE_READ && (table === "events" || table === "artifacts") ? constants.SQLITE_DENY : constants.SQLITE_OK));
  expect(usageHistory(f.db, { boundaries: [10, 20] }).total).toMatchObject({ inputTokens: 30, outputTokens: 5, costUsd: 0.2, sessions: 1 });
});

it("backfills existing inline and artifact accounting when upgrading a ledger", () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = OFF");
  for (const migration of migrations.slice(0, migrations.indexOf(usageHistoryMigration))) {
    if (typeof migration === "string") raw.exec(migration);
    else migration(raw);
  }
  raw.exec("PRAGMA foreign_keys = ON");
  const f = fixture(new Db(raw));
  f.run("existing", "claude");
  f.turn("existing", 12, { inputTokens: 100, outputTokens: 10, costUsd: 1 });
  f.turn("existing", 22, { inputTokens: 200, outputTokens: 20, costUsd: 3 }, "A complete response. ".repeat(100));
  raw.exec(usageHistoryMigration);
  expect(usageHistory(f.db, { boundaries: [10, 20, 30] }).total).toMatchObject({ inputTokens: 300, outputTokens: 30, costUsd: 3, sessions: 1 });
  expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

it("reflects corrected, moved, and deleted accounting without keeping a stale result", () => {
  const f = fixture();
  f.run("corrected", "claude");
  f.turn("corrected", 12, { inputTokens: 10, outputTokens: 1, costUsd: 0.2 });
  f.db.stmt("UPDATE events SET ts = 22, payload = json_set(payload, '$.usage.costUsd', 0.5) WHERE run_id = ?").run("corrected");
  expect(usageHistory(f.db, { boundaries: [10, 20, 30] }).buckets.map((bucket) => bucket.total.costUsd)).toEqual([0, 0.5]);
  f.db.stmt("DELETE FROM events WHERE run_id = ?").run("corrected");
  expect(usageHistory(f.db, { boundaries: [10, 30] }).total).toMatchObject({ sessions: 0, costUsd: 0 });
});

it("follows artifact corrections and deletion and removes accounting with its run", () => {
  const f = fixture();
  f.run("artifact", "claude");
  f.turn("artifact", 12, { inputTokens: 30, outputTokens: 5, costUsd: 0.2 }, "A complete response. ".repeat(100));
  f.db.stmt("UPDATE artifacts SET content = json_set(content, '$.usage.costUsd', 0.8)").run();
  expect(usageHistory(f.db, { boundaries: [10, 20] }).total.costUsd).toBe(0.8);
  f.db.stmt("DELETE FROM artifacts").run();
  expect(usageHistory(f.db, { boundaries: [10, 20] }).total).toMatchObject({ costUsd: null, unpricedSessions: 1 });
  f.turn("artifact", 15, { inputTokens: 40, outputTokens: 6, costUsd: 1 }, "A complete response. ".repeat(100));
  f.db.stmt("DELETE FROM runs WHERE id = ?").run("artifact");
  expect(usageHistory(f.db, { boundaries: [10, 20] }).total.sessions).toBe(0);
  expect(f.db.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

it("drops stale accounting when a corrected artifact or its fallback is malformed", () => {
  const f = fixture();
  f.run("malformed", "claude");
  f.turn("malformed", 12, { inputTokens: 30, outputTokens: 5, costUsd: 0.2 }, "A complete response. ".repeat(100));
  f.db.stmt("UPDATE artifacts SET content = ?").run("malformed");
  expect(usageHistory(f.db, { boundaries: [10, 20] }).total).toMatchObject({ costUsd: 0, sessions: 0 });
  f.db.stmt("UPDATE artifacts SET content = ?").run(JSON.stringify({ usage: { inputTokens: 30, outputTokens: 5, costUsd: 0.8 } }));
  expect(usageHistory(f.db, { boundaries: [10, 20] }).total.costUsd).toBe(0.8);
  f.db.stmt("UPDATE events SET payload = ?").run("malformed");
  f.db.stmt("DELETE FROM artifacts").run();
  expect(usageHistory(f.db, { boundaries: [10, 20] }).total).toMatchObject({ costUsd: 0, sessions: 0 });
});

it("rolls back usage accounting with its events", () => {
  const f = fixture();
  f.run("rolled-back", "claude");
  expect(() =>
    f.db.transaction(() => {
      f.turn("rolled-back", 12, { inputTokens: 30, outputTokens: 5, costUsd: 0.2 });
      throw new Error("Abort import");
    }),
  ).toThrow("Abort import");
  expect(usageHistory(f.db, { boundaries: [10, 20] }).total).toMatchObject({ sessions: 0, costUsd: 0 });
});

it("keeps providers' session identities separate and distinguishes missing prices from free usage", () => {
  const f = fixture();
  f.run("a", "claude", "same-id");
  f.run("b", "codex", "same-id");
  f.turn("a", 12, { inputTokens: 10, outputTokens: 3, costUsd: 2 });
  f.update("b", 15, { inputTokens: 20, outputTokens: 4 });
  expect(usageHistory(f.db, { boundaries: [10, 20] }).total).toMatchObject({ costUsd: 2, sessions: 2, unpricedSessions: 1 });
  expect(usageHistory(f.db, { boundaries: [10, 20], agent: "opencode" }).total).toMatchObject({ costUsd: 0, sessions: 0 });
});

it("rejects reversed, repeated, oversized, and excessively long bucket ranges", () => {
  for (const boundaries of [[20, 10], [10, 10], [0, 95 * 86_400_000], Array.from({ length: 98 }, (_, index) => index)]) {
    expect(UsageHistoryParams.safeParse({ boundaries }).success).toBe(false);
  }
  expect(UsageHistoryParams.safeParse({ boundaries: [10, 20, 30] }).success).toBe(true);
});

it("does not add a hosted child's cost again, including its earlier runs", () => {
  const f = fixture();
  f.run("parent", "opencode");
  f.turn("parent", 15, { inputTokens: 100, outputTokens: 10, costUsd: 3 });
  const child = threads.insert(f.db, { projectId: f.project.id, title: "Explore", agent: "opencode", model: null, mode: "act", permissionMode: "trusted" });
  for (const id of ["child-first", "child-next"]) {
    runs.insert(f.db, { id, taskId: null, threadId: child.id, agent: "opencode", model: null, mode: "act", permissionMode: "trusted" });
    f.turn(id, 14, { inputTokens: 80, outputTokens: 8, costUsd: 1 });
  }
  subagents.insert(f.db, {
    threadId: child.id,
    runId: "child-next",
    hostRunId: "parent",
    rootThreadId: child.id,
    nativeId: "native-child",
    toolCallId: null,
    taskId: null,
    agentType: null,
    prompt: null,
    status: "completed",
    result: null,
    startedAt: 10,
    endedAt: 15,
  });
  expect(usageHistory(f.db, { boundaries: [10, 20] }).total).toMatchObject({ sessions: 1, costUsd: 3, inputTokens: 100 });
});
