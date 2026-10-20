import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { ClaudeAdapter, ClaudeStreamParser, RunHandle } from "@openorc/agents";
import { runs, threads } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import type { CorePush, Project } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";

let root: string;
let dataDir: string;
let core: OpenOrc;
let project: Project;
const push = vi.fn<(message: CorePush) => void>();
const live: string[] = [];

const session_id = "dd1b0fd3-115e-4d6d-8274-0001c648144c";
const model = "claude-opus-5-5";
/** One answered prompt: the assistant line carries what the model read, the result line the model's window. */
const firstTurn = [
  { type: "system", subtype: "init", session_id, model, cwd: "/repo", tools: ["Bash"], uuid: "init-1" },
  {
    type: "assistant",
    message: {
      model,
      id: "msg_01",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
      usage: { input_tokens: 1127, cache_creation_input_tokens: 16000, cache_read_input_tokens: 834800, output_tokens: 8, service_tier: "standard" },
    },
    session_id,
    uuid: "a1",
  },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1200,
    num_turns: 1,
    result: "Done.",
    session_id,
    total_cost_usd: 1.5,
    usage: { input_tokens: 1127, cache_creation_input_tokens: 16000, cache_read_input_tokens: 834800, output_tokens: 8 },
    modelUsage: { [model]: { inputTokens: 1127, outputTokens: 8, cacheReadInputTokens: 834800, cacheCreationInputTokens: 16000, costUSD: 1.5, contextWindow: 1000000 } },
    uuid: "r1",
  },
];
/** The lines Claude Code 2.1 writes for a /compact, as recorded from a live session: a boundary with the new size, then a result that is no turn. */
const compaction = [
  { type: "system", subtype: "status", status: "compacting", session_id, uuid: "26f46039" },
  { type: "system", subtype: "status", status: null, compact_result: "success", session_id, uuid: "88359417" },
  { type: "system", subtype: "init", cwd: "/repo", session_id, model, tools: ["Bash"], uuid: "init-2" },
  {
    type: "system",
    subtype: "compact_boundary",
    session_id,
    uuid: "93cfb0e3",
    compact_metadata: { trigger: "manual", pre_tokens: 851927, post_tokens: 22712, cumulative_dropped_tokens: 1784374, duration_ms: 71965, pre_compact_discovered_tools: [] },
  },
  { type: "user", message: { role: "user", content: "This session is being continued from a previous conversation that ran out of context." }, session_id, uuid: "93c1", isReplay: true },
  { type: "user", message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" }, session_id, uuid: "d50f", isReplay: true },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 72886,
    num_turns: 0,
    result: "",
    session_id,
    total_cost_usd: 414.5,
    usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
    modelUsage: { [model]: { inputTokens: 15148, outputTokens: 4376549, costUSD: 414.5, contextWindow: 1000000 } },
    local_command: "compact",
    uuid: "360a6b32",
  },
];

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-compaction-repo-"));
  dataDir = await mkdtemp(path.join(os.tmpdir(), "openorc-compaction-data-"));
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(path.join(root, "README.md"), "# Compaction fixture\n");
  await commitAll(root, "init");
  core = await OpenOrc.create({ dataDir, ephemeral: true, transport: { push } });
  project = await core.projects.import(root);
  // An ended turn names its thread; a real titler would still be running when the core closes.
  vi.spyOn(core.textGeneration, "title").mockResolvedValue(null);
});
afterEach(async () => {
  await Promise.all(live.splice(0).map((id) => core.runs.closeAndWait(id)));
  if (vi.isMockFunction(ClaudeAdapter.prototype.start)) vi.mocked(ClaudeAdapter.prototype.start).mockRestore();
});
afterAll(async () => {
  await core.close();
  await rm(root, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

it("shows the compacted size on the thread as soon as compaction finishes, before any turn", async () => {
  const thread = threads.insert(core.db, { projectId: project.id, title: "Compaction", agent: "claude", model, mode: "act", permissionMode: "trusted" });
  let parser!: ClaudeStreamParser;
  let handle!: RunHandle;
  const feed = (lines: unknown[]) => {
    for (const row of lines) for (const ev of parser.parseLine(JSON.stringify(row))) handle.emit("event", ev);
  };
  vi.spyOn(ClaudeAdapter.prototype, "start").mockImplementation((spec) => {
    parser = new ClaudeStreamParser(spec.runId);
    let finish!: (code: number) => void;
    const done = new Promise<number>((resolve) => {
      finish = resolve;
    });
    handle = new RunHandle(spec.runId, {
      interrupt() {},
      send: async () => {},
      close() {
        handle.emit("exit", 0);
        finish(0);
      },
      // The real adapter settles /compact on the compaction activity the stream reports, after the boundary line.
      compact: async () => {
        parser.expectManualCompaction();
        feed(compaction);
      },
      done,
    });
    return handle;
  });
  const run = await core.runs.start({ scope: { thread, task: null }, project, agent: "claude", model, mode: "act", permissionMode: "trusted", prompt: "Work", resume: false });
  live.push(run.id);
  feed(firstTurn);
  await vi.waitFor(() => expect(core.runs.isBusy(run.id)).toBe(false));
  expect(core.runs.threadContext(thread.id)).toEqual({ used: 851_927, window: 1_000_000 });

  // What the thread shows each time the renderer is told it changed: the last refetch must carry the compacted size.
  const shown: (number | undefined)[] = [];
  push.mockImplementation((message) => {
    if (message.type === "invalidate" && message.keys.includes(`thread:${thread.id}`)) shown.push(core.runs.threadContext(thread.id)?.used);
  });
  const turnsCompleted = vi.fn();
  handle.on("event", (ev) => {
    if (ev.type === "turn.completed") turnsCompleted();
  });
  await core.runs.compact(run.id);
  await vi.waitFor(() => expect(shown.at(-1)).toBe(22_712));
  expect(turnsCompleted).not.toHaveBeenCalled();
  expect(core.runs.isBusy(run.id)).toBe(false);
  const view = await core.handle({ type: "rpc", id: 1, method: "threads.get", params: { id: thread.id } });
  expect(view).toMatchObject({ type: "rpc.result", result: { context: { used: 22_712, window: 1_000_000 } } });
});

it("keeps the window the thread last reported when a session only compacted", async () => {
  const thread = threads.insert(core.db, { projectId: project.id, title: "Compacted only", agent: "claude", model, mode: "act", permissionMode: "trusted" });
  const answered = runs.insert(core.db, { id: "answered", taskId: null, threadId: thread.id, agent: "claude", model, mode: "act", permissionMode: "trusted" });
  runs.update(core.db, answered.id, { state: "success", endedAt: Date.now(), usage: { inputTokens: 1127, outputTokens: 8, contextTokens: 851_927, contextWindow: 1_000_000 } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const compacted = runs.insert(core.db, { id: "compacted", taskId: null, threadId: thread.id, agent: "claude", model, mode: "act", permissionMode: "trusted" });
  runs.update(core.db, compacted.id, { state: "success", endedAt: Date.now(), usage: { inputTokens: 0, outputTokens: 0, contextTokens: 22_712 } });
  expect(core.runs.threadContext(thread.id)).toEqual({ used: 22_712, window: 1_000_000 });
});
