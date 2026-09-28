import { afterEach, describe, expect, it, vi } from "vitest";
import { Db, extractionJobs, LedgerWriter, memories, projects, runs, settings, summaries, threads } from "@openorc/db";
import { Embedder, type Extractor, type RunDigest } from "@openorc/memory";
import type { AgentEvent, Run } from "@openorc/protocol";
import { MemoryService, type ProviderInfo } from "./memory.js";

const silent = { info() {}, warn() {}, error() {} };
const providers: ProviderInfo = {
  models: async () => [],
  loggedIn: async () => ({ claude: true, codex: false, opencode: false }),
  launch: (agent) => ({ revision: 1, binary: agent, env: Object.freeze({ PATH: "/fixture" }) }),
};

function setup() {
  const db = Db.memory();
  settings.set(db, "memory.enabled", "true");
  const project = projects.insert(db, { name: "demo", rootPath: "/tmp/demo", gitRemote: null, defaultBranch: "main", settings: {} });
  const memory = new MemoryService(db, { dataDir: "/tmp", secrets: { load: async () => null, save: async () => {} } }, providers, () => {}, silent);
  const thread = threads.insert(db, { projectId: project.id, title: "Export", agent: "claude", model: "fixture", mode: "act", permissionMode: "trusted" });
  const ledger = new LedgerWriter(db, { flushMs: 1000, maxBatch: 100_000 });
  const run = (id: string, events: (runId: string) => AgentEvent[]): Run => {
    const inserted = runs.insert(db, { id, taskId: null, threadId: thread.id, agent: "claude", model: "fixture", mode: "act", permissionMode: "trusted" });
    for (const ev of events(id)) ledger.push(ev);
    ledger.flush();
    return inserted;
  };
  return { memory, db, project, run, scope: { task: null, thread } };
}

const prompt = (runId: string): AgentEvent => ({ type: "message.completed", runId, ts: 1, messageId: "u1", role: "user", text: "Fix the export" });
const reply = (runId: string, text: string, ts: number): AgentEvent => ({ type: "message.completed", runId, ts, messageId: `a${ts}`, role: "assistant", text });
const result = { summary: { request: "r", workDone: "w", outcome: "o", openItems: [] as string[] }, memories: [] };

const idle = (memory: MemoryService) => vi.waitFor(() => expect(memory.hasPendingWork).toBe(false), { timeout: 5_000 });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("memory extraction", () => {
  it("runs at most two distillations at once and queues the rest", async () => {
    const { memory, project, run, scope } = setup();
    let running = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    vi.spyOn(MemoryService.prototype, "extractor").mockResolvedValue({
      extract: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => releases.push(resolve));
        running -= 1;
        return result;
      },
    } as unknown as Extractor);
    for (const id of ["a", "b", "c", "d"])
      memory.onRunFinished(
        run(id, (runId) => [prompt(runId), reply(runId, "done", 2)]),
        scope,
        project,
      );
    for (let released = 0; released < 4; released += 1) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(released));
      releases[released]!();
    }
    await idle(memory);
    expect(peak).toBe(2);
  });

  it("keeps a long run's opening request when only its newest events fit", async () => {
    const { memory, project, run, scope } = setup();
    const long = run("opening", (id) => [
      { type: "message.completed", runId: id, ts: 1, messageId: "u1", role: "user", text: "Build the CSV export" },
      ...Array.from({ length: 6000 }, (_, i) => reply(id, `step ${i}`, 2 + i)),
    ]);
    const digests: RunDigest[] = [];
    vi.spyOn(MemoryService.prototype, "extractor").mockResolvedValue({ extract: async (digest: RunDigest) => (digests.push(digest), result) } as unknown as Extractor);
    memory.onRunFinished(long, scope, project);
    await idle(memory);
    expect(digests[0]?.prompts).toEqual(["Build the CSV export"]);
    expect(digests[0]?.assistant.at(-1)).toBe("step 5999");
  });

  it("does not distill a run that was waiting when memory learning was turned off, even if it is back on", async () => {
    const { memory, db, project, run, scope } = setup();
    const releases: Array<() => void> = [];
    const extracted: string[] = [];
    vi.spyOn(MemoryService.prototype, "extractor").mockResolvedValue({
      extract: async (digest: RunDigest) => {
        extracted.push(digest.assistant[0] ?? "");
        await new Promise<void>((resolve) => releases.push(resolve));
        return result;
      },
    } as unknown as Extractor);
    for (const id of ["a", "b", "c"])
      memory.onRunFinished(
        run(id, (runId) => [prompt(runId), reply(runId, runId, 2)]),
        scope,
        project,
      );
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    await memory.updateSettings({ enabled: false });
    await memory.updateSettings({ enabled: true });
    releases.forEach((release) => release());
    await idle(memory);
    expect(extracted).toEqual(["a", "b"]);
    expect(extractionJobs.get(db, "c")).toMatchObject({ state: "skipped", error: "memory learning was disabled" });
  });

  it("frees a distillation slot once its memories are written, while they are still embedding", async () => {
    const { memory, project, run, scope } = setup();
    vi.spyOn(Embedder.prototype, "embed").mockReturnValue(new Promise(() => {}));
    const extracted: string[] = [];
    const learned = { ...result, memories: [{ type: "decision" as const, topicKey: "export", title: "Export", body: "Use CSV.", confidence: 0.9, files: [] }] };
    vi.spyOn(MemoryService.prototype, "extractor").mockResolvedValue({ extract: async (digest: RunDigest) => (extracted.push(digest.assistant[0] ?? ""), learned) } as unknown as Extractor);
    for (const id of ["a", "b", "c"])
      memory.onRunFinished(
        run(id, (runId) => [prompt(runId), reply(runId, runId, 2)]),
        scope,
        project,
      );
    await vi.waitFor(() => expect(extracted).toEqual(["a", "b", "c"]));
  });
  it("leaves a topic the user wrote alone and still saves the run's summary and other memories", async () => {
    const { memory, db, project, run, scope } = setup();
    vi.spyOn(Embedder.prototype, "embed").mockReturnValue(new Promise(() => {}));
    const mine = memories.upsert(db, { projectId: project.id, type: "decision", topicKey: "export", title: "Export", body: "Use JSON.", source: "user" }).memory;
    const learned = {
      ...result,
      memories: [
        { type: "decision" as const, topicKey: "export", title: "Export", body: "Use CSV.", confidence: 0.9, files: [] },
        { type: "gotcha" as const, topicKey: "export-encoding", title: "Encoding", body: "Write UTF-8 with a BOM.", confidence: 0.8, files: [] },
      ],
    };
    vi.spyOn(MemoryService.prototype, "extractor").mockResolvedValue({ extract: async () => learned } as unknown as Extractor);
    const finished = run("clash", (runId) => [prompt(runId), reply(runId, "done", 2)]);
    memory.onRunFinished(finished, scope, project);
    await vi.waitFor(() => expect(extractionJobs.get(db, finished.id)?.state).toBe("done"));

    expect(extractionJobs.get(db, finished.id)).toMatchObject({ memoriesWritten: 1 });
    expect(summaries.forRun(db, finished.id)).not.toBeNull();
    expect(memories.get(db, mine.id)).toMatchObject({ body: "Use JSON.", source: "user" });
    expect(
      memories
        .list(db, { projectId: project.id })
        .map((m) => m.topicKey)
        .sort(),
    ).toEqual(["export", "export-encoding"]);
  });
});
