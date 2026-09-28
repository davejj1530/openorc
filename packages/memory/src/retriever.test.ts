import { afterEach, describe, expect, it, vi } from "vitest";
import { Db, memories, projects, vectors } from "@openorc/db";
import { Retriever } from "./retriever.js";

const opened: Db[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const db of opened.splice(0)) db.close();
});
function fixture() {
  const db = Db.memory();
  opened.push(db);
  const project = projects.insert(db, { name: "OpenOrc", rootPath: "/qa/openorc", gitRemote: null, defaultBranch: "main", settings: {} });
  const other = projects.insert(db, { name: "Other", rootPath: "/qa/other", gitRemote: null, defaultBranch: "main", settings: {} });
  const insert = (title: string, body: string, projectId = project.id) => memories.upsert(db, { projectId, type: "lesson", title, body, source: "user" }).memory;
  return { db, project, other, insert };
}

describe("memory retrieval usefulness and fallback", () => {
  it("finds task-shaped lessons and excludes retracted and foreign-project advice", async () => {
    const { db, project, other, insert } = fixture();
    const good = insert("Preserve drafts after failed sends", "Clear the message only after successful delivery. Retain attachments for retry.");
    const stale = insert("Clear drafts before sending", "Discard attachments immediately.");
    memories.feedback(db, stale.id, "wrong");
    insert("Preserve drafts", "Unrelated repository policy", other.id);
    insert("Worktree setup", "Copy ignored environment files before running the setup script.");
    insert("Diff performance", "Highlight code with the worker pool.");
    const hits = await new Retriever(db, { embedQuery: async () => null }).retrieve({ projectId: project.id, query: "drafts failed sends attachments", limit: 3 });
    expect(hits[0]?.memory.id).toBe(good.id);
    expect(hits.every((h) => h.memory.projectId === project.id && h.memory.status === "active")).toBe(true);
  });

  it("returns keyword results within the budget while a model download stalls", async () => {
    vi.useFakeTimers();
    const { db, project, insert } = fixture();
    const good = insert("Worktree environment", "Copy .env files during worktree preparation.");
    const pending = new Retriever(db, { embedQuery: () => new Promise(() => {}) }, 500).retrieve({ projectId: project.id, query: "worktree environment" });
    await vi.advanceTimersByTimeAsync(500);
    expect((await pending)[0]?.memory.id).toBe(good.id);
  });

  it("falls back to full text when the embedding provider rejects", async () => {
    const { db, project, insert } = fixture();
    const good = insert("Recover interrupted sessions", "Keep the durable thread when a provider loses its session.");
    const hits = await new Retriever(db, {
      embedQuery: async () => {
        throw new Error("offline");
      },
    }).retrieve({ projectId: project.id, query: "interrupted sessions" });
    expect(hits[0]?.memory.id).toBe(good.id);
  });

  it("can retrieve a semantic candidate with no shared query words", async (context) => {
    const { db, project, insert } = fixture();
    if (!db.hasVectors) {
      context.skip();
      return;
    }
    const target = insert("Keep user work", "Retain unsent messages until delivery succeeds.");
    const unrelated = insert("Database backups", "Checkpoint WAL before copying the database.");
    const vector = new Float32Array(384);
    vector[0] = 1;
    const opposite = new Float32Array(384);
    opposite[1] = 1;
    vectors.put(db, target.id, vector);
    vectors.put(db, unrelated.id, opposite);
    const query = "composer resilience";
    expect(memories.search(db, query, project.id)).toHaveLength(0);
    const hits = await new Retriever(db, { embedQuery: async () => vector }).retrieve({ projectId: project.id, query, limit: 1 });
    expect(hits[0]?.memory.id).toBe(target.id);
  });
});
