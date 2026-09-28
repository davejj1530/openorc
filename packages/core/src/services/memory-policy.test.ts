import { afterEach, describe, expect, it, vi } from "vitest";
import { Db, extractionJobs, LedgerWriter, memories, projects, runs, settings, summaries, tasks } from "@openorc/db";
import { Embedder, Extractor, Retriever, type Extraction } from "@openorc/memory";
import { MemoryService } from "./memory.js";

const databases: Db[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const extraction: Extraction = {
  summary: { request: "Remember a lesson", workDone: "Verified the fixture", outcome: "success", openItems: [] },
  memories: [{ type: "lesson", title: "Fixture lesson", body: "Retain the verified result.", topicKey: null, confidence: 0.8, files: [] }],
};
function fixture(enabled = true) {
  const db = Db.memory();
  databases.push(db);
  if (enabled) settings.set(db, "memory.enabled", "true");
  vi.spyOn(Embedder.prototype, "embed").mockResolvedValue(null);
  vi.spyOn(Embedder.prototype, "embedQuery").mockResolvedValue(null);
  const providers = { loggedIn: async () => ({ claude: true, codex: true, opencode: false }), models: async () => [], launch: () => ({ revision: 1, binary: "fixture", env: {} }) };
  const make = () => new MemoryService(db, { dataDir: "/tmp", secrets: { load: async () => null, save: async () => {} } }, providers, () => {}, { info() {}, warn() {}, error() {} });
  const memory = make();
  const project = projects.insert(db, { name: "Fixture", rootPath: "/tmp/memory-policy", gitRemote: null, defaultBranch: null, settings: {} });
  const task = tasks.insert(db, {
    projectId: project.id,
    title: "Memory policy",
    spec: "Keep task instructions",
    priority: "none",
    labels: [],
    workspaceMode: "current",
    baseRef: null,
    parentTaskId: null,
  });
  const run = runs.insert(db, { id: "policy-run", taskId: task.id, threadId: null, agent: "claude", model: null, mode: "act", permissionMode: "trusted" });
  const ledger = new LedgerWriter(db);
  ledger.push({ type: "message.completed", runId: run.id, ts: Date.now(), role: "user", messageId: "prompt", text: "Remember a lesson" });
  ledger.close();
  const input = { projectId: project.id, type: "lesson" as const, title: "Saved fixture lesson", body: "Useful context", source: "agent" as const };
  const saved = memories.upsert(db, input).memory;
  return { db, make, memory, project, task, run, input, saved };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
});

describe("OpenOrc memory master switch", () => {
  it("starts off in a new profile and persists an independent master choice", async () => {
    const { memory, make } = fixture(false);
    await memory.updateSettings({ provider: "off" });
    expect(await memory.settings()).toMatchObject({ enabled: false, provider: "off" });
    await memory.updateSettings({ enabled: true });
    expect(await make().settings()).toMatchObject({ enabled: true, provider: "off" });
    await memory.updateSettings({ enabled: false, provider: "claude" });
    expect(await make().settings()).toMatchObject({ enabled: false, provider: "claude", resolved: null });
  });

  it("blocks recording, recall and briefs while retaining user curation", async () => {
    const { memory, project, task, input, saved } = fixture();
    expect(memory.brief(project)).toContain(saved.title);
    await memory.updateSettings({ enabled: false });
    expect(() => memory.record(input)).toThrow(/memory is off/i);
    expect(await memory.retrieve(project.id, "fixture", 8)).toEqual([]);
    expect(memory.brief(project)).toBe("");
    expect(await memory.taskContext(task)).not.toContain(saved.title);
    expect(await memory.taskContext(task)).toContain("Keep task instructions");
    expect(memory.list(project.id)).toHaveLength(1);
    expect(memory.update(saved.id, { title: "Corrected lesson" }).title).toBe("Corrected lesson");
    memory.remove(saved.id);
    expect(memory.list(project.id)).toEqual([]);
  });

  it.each([true])("discards in-flight extraction after Off (then On: %s)", async (reenable) => {
    const { memory, db, run, task, project } = fixture();
    const pending = deferred<Extraction>();
    const extract = vi.spyOn(Extractor.prototype, "extract").mockReturnValue(pending.promise);
    memory.onRunFinished(run, { task, thread: null }, project);
    await vi.waitFor(() => expect(extract).toHaveBeenCalled());
    await memory.updateSettings({ enabled: false });
    if (reenable) await memory.updateSettings({ enabled: true });
    pending.resolve(extraction);
    await vi.waitFor(() => expect(extractionJobs.get(db, run.id)?.state).toBe("skipped"));
    expect(memory.list(project.id)).toHaveLength(1);
    expect(summaries.forTask(db, task.id)).toEqual([]);
  });

  it("discards an agent search that completes after Off, even if re-enabled", async () => {
    const { memory, project, saved } = fixture();
    const pending = deferred<{ memory: typeof saved; score: number }[]>();
    vi.spyOn(Retriever.prototype, "retrieve").mockReturnValue(pending.promise);
    const search = memory.retrieve(project.id, "fixture", 8);
    await memory.updateSettings({ enabled: false });
    await memory.updateSettings({ enabled: true });
    pending.resolve([{ memory: saved, score: 1 }]);
    expect(await search).toEqual([]);
  });

  it("drains extraction before shutdown completes and rejects new work", async () => {
    const { memory, db, run, task, project } = fixture();
    const pending = deferred<Extraction>();
    const extract = vi.spyOn(Extractor.prototype, "extract").mockReturnValue(pending.promise);
    memory.onRunFinished(run, { task, thread: null }, project);
    await vi.waitFor(() => expect(extract).toHaveBeenCalled());
    let closed = false;
    const closing = memory.shutdown().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    await expect(memory.updateSettings({ enabled: true })).rejects.toThrow(/shutting down/);
    memory.onRunFinished(run, { task, thread: null }, project);
    expect(extract).toHaveBeenCalledTimes(1);
    pending.resolve(extraction);
    await closing;
    expect(extractionJobs.get(db, run.id)?.state).toBe("skipped");
    expect(summaries.forTask(db, task.id)).toEqual([]);
    expect(memory.list(project.id)).toHaveLength(1);
    expect(memory.enabled()).toBe(false);
  });

  it("drains pending embedding and backfill writes before releasing the database", async () => {
    const { memory, db, input } = fixture();
    const pending = deferred<null>();
    const embed = vi.mocked(Embedder.prototype.embed).mockReturnValue(pending.promise);
    memory.record(input);
    const backfill = memory.backfillVectors();
    expect(embed).toHaveBeenCalledTimes(2);
    let closed = false;
    const closing = memory.shutdown().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    pending.resolve(null);
    await Promise.all([backfill, closing]);
    expect(closed).toBe(true);
    expect(db.raw.isOpen).toBe(true);
  });

  it("searches saved memories by words alone while memory is off, so the model is never downloaded", async () => {
    const { memory, project, saved } = fixture(false);
    const embedQuery = vi.mocked(Embedder.prototype.embedQuery);
    expect((await memory.searchSaved(project.id, "fixture", 8)).map((hit) => hit.memory.id)).toEqual([saved.id]);
    expect(embedQuery).not.toHaveBeenCalled();
    await memory.updateSettings({ enabled: true });
    await memory.searchSaved(project.id, "fixture", 8);
    expect(embedQuery).toHaveBeenCalledWith("fixture");
  });

  it("drains admitted searches and fences new searches only during shutdown", async () => {
    const { memory, project, saved } = fixture();
    await memory.updateSettings({ enabled: false });
    const pending = deferred<{ memory: typeof saved; score: number }[]>();
    const retrieve = vi.spyOn(Retriever.prototype, "retrieve").mockReturnValue(pending.promise);
    const search = memory.searchSaved(project.id, "fixture", 8);
    expect(memory.hasPendingWork).toBe(true);
    let closed = false;
    const closing = memory.shutdown().then(() => {
      closed = true;
    });
    await expect(memory.searchSaved(project.id, "fixture", 8)).resolves.toEqual([]);
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(closed).toBe(false);
    pending.resolve([{ memory: saved, score: 1 }]);
    await expect(search).resolves.toEqual([{ memory: saved, score: 1 }]);
    await closing;
    expect(memory.hasPendingWork).toBe(false);
  });
});
