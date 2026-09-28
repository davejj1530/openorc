import { describe, expect, it } from "vitest";
import { Db } from "./database.js";
import { memories, vectors, ftsQuery, summaries, extractionJobs } from "./memories.js";
import { projects, runs, tasks } from "./repos.js";

function fixture() {
  const db = Db.memory();
  const project = projects.insert(db, { name: "demo", rootPath: "/tmp/demo-mem", gitRemote: null, defaultBranch: "main", settings: {} });
  const task = tasks.insert(db, { projectId: project.id, title: "CSV export", spec: null, priority: "medium", labels: [], workspaceMode: "worktree", baseRef: null, parentTaskId: null });
  const run = runs.insert(db, { id: "run-m1", taskId: task.id, threadId: null, agent: "codex", model: "gpt-5.6-sol", mode: "act", permissionMode: "trusted" });
  return { db, project, task, run };
}

describe("ftsQuery", () => {
  it("quotes and ORs words, prefixes the last, drops punctuation", () => {
    expect(ftsQuery("vitest --pool=forks")).toBe('"vitest" OR "pool" OR "forks"*');
    expect(ftsQuery("  ")).toBeNull();
    expect(ftsQuery("a")).toBeNull();
  });
});

describe("memories", () => {
  it("pages beyond 500 entries without dropping or repeating tied timestamps", () => {
    const { db, project } = fixture();
    const ids = Array.from(
      { length: 527 },
      (_, index) =>
        memories.upsert(db, {
          projectId: project.id,
          type: "lesson",
          title: `Memory ${index}`,
          body: "Saved knowledge",
          source: "agent",
        }).memory.id,
    );
    db.stmt("UPDATE memories SET updated_at = 1000").run();
    const expected = [...ids].sort().reverse();
    const received: string[] = [];
    for (let offset = 0; offset < ids.length; offset += 25) {
      const page = memories.list(db, { projectId: project.id, limit: 26, offset });
      expect(page.map((m) => m.id)).toEqual(expected.slice(offset, offset + 26));
      received.push(...page.slice(0, 25).map((m) => m.id));
    }
    expect(received).toEqual(expected);
    expect(memories.list(db, { projectId: project.id, limit: 26, offset: 550 })).toEqual([]);
    db.stmt("UPDATE memories SET updated_at = 2000 WHERE id = ?").run(expected.at(-1)!);
    expect(memories.list(db, { projectId: project.id, limit: 1 })[0]?.id).toBe(expected.at(-1));
    db.close();
  });

  it("applies source, type, status and project scope before paging", () => {
    const { db, project } = fixture();
    const input = { projectId: project.id, type: "command", title: "A command", body: "pnpm test", source: "user" } as const;
    const scoped = memories.upsert(db, input).memory;
    const shared = memories.upsert(db, { ...input, projectId: null, scope: "user" }).memory;
    const global = memories.upsert(db, { ...input, projectId: null, scope: "global" }).memory;
    const retracted = memories.upsert(db, input).memory;
    memories.feedback(db, retracted.id, "wrong");
    memories.upsert(db, { ...input, type: "lesson" });
    memories.upsert(db, { ...input, source: "agent" });
    const other = projects.insert(db, { name: "Other", rootPath: "/tmp/other-mem", gitRemote: null, defaultBranch: null, settings: {} });
    memories.upsert(db, { ...input, projectId: other.id });
    db.stmt("UPDATE memories SET updated_at = 1000").run();
    const filters = { projectId: project.id, types: [input.type], sources: [input.source], statuses: ["active" as const], limit: 2 };
    const expected = [scoped.id, shared.id, global.id].sort().reverse();
    expect(memories.list(db, filters).map((m) => m.id)).toEqual(expected.slice(0, 2));
    expect(memories.list(db, { ...filters, offset: 2 }).map((m) => m.id)).toEqual(expected.slice(2));
    db.close();
  });

  it("redacts what memories, summaries, and extraction errors keep", () => {
    const { db, project, run } = fixture();
    const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12";
    const { memory } = memories.upsert(db, { projectId: project.id, type: "lesson", title: `Deploy with ${token}`, body: `DB_PASSWORD=hunter2hunter2 then ${token}`, source: "agent" });
    expect(memory.title).toBe("Deploy with [redacted:github-token]");
    expect(memories.update(db, memory.id, { body: `Rotated to ${token}` }).body).toBe("Rotated to [redacted:github-token]");
    summaries.upsert(db, { runId: run.id, taskId: null, threadId: null, projectId: project.id, request: token, workDone: token, outcome: token, openItems: [token], model: null });
    extractionJobs.start(db, run.id);
    extractionJobs.finish(db, run.id, { state: "failed", error: `401 for ${token}` });
    const stored = JSON.stringify([db.stmt("SELECT * FROM memories").all(), db.stmt("SELECT * FROM session_summaries").all(), db.stmt("SELECT * FROM extraction_jobs").all()]);
    expect(stored).not.toContain(token);
    expect(stored).not.toContain("hunter2hunter2");
  });

  it("upserts by topic key, folding evidence instead of duplicating", () => {
    const { db, project, run } = fixture();
    const first = memories.upsert(db, {
      projectId: project.id,
      type: "lesson",
      topicKey: "test/pool",
      title: "Use forks pool",
      body: "Threads pool hangs on native modules.",
      source: "extraction",
      sourceRunId: run.id,
    });
    expect(first.merged).toBe(false);
    const second = memories.upsert(db, { projectId: project.id, type: "lesson", topicKey: "test/pool", title: "Use forks pool", body: "Confirmed again.", source: "extraction" });
    expect(second.merged).toBe(true);
    expect(second.memory.id).toBe(first.memory.id);
    expect(second.memory.evidenceCount).toBe(2);
    expect(memories.list(db, { projectId: project.id })).toHaveLength(1);
  });

  it("finds memories by full-text search, active and in scope only", () => {
    const { db, project } = fixture();
    memories.upsert(db, { projectId: project.id, type: "command", title: "Run the fast unit suite", body: "pnpm test:unit skips docker integration tests.", source: "extraction" });
    memories.upsert(db, { projectId: project.id, type: "lesson", title: "Escape CSV quotes", body: "Double the quote character inside quoted fields.", source: "extraction" });
    const hits = memories.search(db, "csv quote", project.id);
    expect(hits[0]?.memory.title).toBe("Escape CSV quotes");
    const other = memories.search(db, "csv quote", "another-project");
    expect(other).toHaveLength(0);
  });

  it("retracts and confirms through feedback", () => {
    const { db, project } = fixture();
    const m = memories.upsert(db, { projectId: project.id, type: "decision", title: "Use SQLite", body: "Local first.", source: "user" }).memory;
    expect(memories.feedback(db, m.id, "helpful").confidence).toBeGreaterThan(m.confidence);
    expect(memories.feedback(db, m.id, "wrong").status).toBe("retracted");
    expect(memories.search(db, "sqlite", project.id)).toHaveLength(0);
  });
});

describe("vectors", () => {
  it("stores embeddings and returns nearest active memories", () => {
    const { db, project } = fixture();
    if (!db.hasVectors) return; // extension not present on this platform
    const a = memories.upsert(db, { projectId: project.id, type: "lesson", title: "A", body: "alpha", source: "extraction" }).memory;
    const b = memories.upsert(db, { projectId: project.id, type: "lesson", title: "B", body: "beta", source: "extraction" }).memory;
    vectors.put(db, a.id, new Float32Array([1, 0, ...new Array(382).fill(0)]));
    vectors.put(db, b.id, new Float32Array([0, 1, ...new Array(382).fill(0)]));
    const near = vectors.knn(db, new Float32Array([0.9, 0.1, ...new Array(382).fill(0)]), project.id, 1);
    expect(near[0]?.memory.id).toBe(a.id);
    expect(vectors.missing(db)).toHaveLength(0);
  });
});

describe("summaries and jobs", () => {
  it("stores one summary per run and tracks extraction jobs", () => {
    const { db, project, task, run } = fixture();
    summaries.upsert(db, {
      runId: run.id,
      taskId: task.id,
      threadId: null,
      projectId: project.id,
      request: "Add export",
      workDone: "Wrote the writer",
      outcome: "done",
      openItems: ["docs"],
      model: "gpt-5.6-sol",
    });
    expect(summaries.forRun(db, run.id)?.workDone).toBe("Wrote the writer");
    expect(summaries.recent(db, project.id)).toHaveLength(1);
    extractionJobs.start(db, run.id);
    extractionJobs.finish(db, run.id, { state: "done", memoriesWritten: 3 });
    expect(extractionJobs.get(db, run.id)?.memoriesWritten).toBe(3);
  });
});
