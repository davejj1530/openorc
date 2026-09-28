import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { memories, projects, runs, settings, threads } from "@openorc/db";
import { Embedder } from "@openorc/memory";
import type { CorePush, RpcMethod, RpcParams } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";

let core: OpenOrc;
let folder: string;
let projectId: string;
let memoryId: string;
let coreClosed: boolean;
const pushed: CorePush[] = [];
beforeEach(async () => {
  coreClosed = false;
  vi.spyOn(Embedder.prototype, "embed").mockResolvedValue(null);
  vi.spyOn(Embedder.prototype, "embedQuery").mockResolvedValue(null);
  folder = await mkdtemp(join(tmpdir(), "openorc-memory-policy-"));
  core = await OpenOrc.create({ dataDir: folder, ephemeral: true, transport: { push: (m) => pushed.push(m) } });
  settings.set(core.db, "memory.enabled", "true");
  projectId = projects.insert(core.db, { name: "Policy", rootPath: folder, gitRemote: null, defaultBranch: null, settings: {} }).id;
  const thread = threads.insert(core.db, { projectId, title: "Policy", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  runs.insert(core.db, { id: "memory-run", threadId: thread.id, taskId: null, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  // This fixture supplies the run record without launching a provider process.
  vi.spyOn(core.runs, "isLive").mockImplementation((id) => id === "memory-run");
  memoryId = memories.upsert(core.db, { projectId, type: "lesson", title: "Fixture lesson", body: "Preserve the result", source: "agent" }).memory.id;
});
afterEach(async () => {
  if (!coreClosed) await core.close();
  vi.restoreAllMocks();
  await rm(folder, { recursive: true, force: true });
});

it("keeps the database open until an admitted extraction finishes during core shutdown", async () => {
  let release!: () => void;
  const pending = new Promise<null>((resolve) => {
    release = () => resolve(null);
  });
  const extractor = vi.spyOn(core.memory, "extractor").mockReturnValue(pending);
  const run = runs.get(core.db, "memory-run")!;
  const thread = threads.get(core.db, run.threadId!)!;
  const project = projects.get(core.db, projectId)!;
  core.ledger.push({ type: "message.completed", runId: run.id, ts: Date.now(), role: "user", messageId: "shutdown-prompt", text: "Remember the fixture" });
  core.ledger.flush();
  core.memory.onRunFinished(run, { task: null, thread }, project);
  expect(extractor).toHaveBeenCalledTimes(1);
  expect(core.prepareForUpdate()).toMatch(/Wait for memory processing/);
  const closing = core.close();
  try {
    await vi.waitFor(() => expect(core.memory.enabled()).toBe(false));
    expect(core.db.raw.isOpen).toBe(true);
  } finally {
    release();
    await closing;
    coreClosed = true;
  }
  expect(core.db.raw.isOpen).toBe(false);
});
async function rpc<M extends RpcMethod>(method: M, params: RpcParams<M>) {
  pushed.length = 0;
  await core.handle({ type: "rpc", id: 1, method, params });
  return pushed.find((m) => (m.type === "rpc.result" || m.type === "rpc.error") && m.id === 1);
}
async function mcpRequest(method: string, params: object = {}) {
  const mcp = await core.mcpServer();
  const response = await fetch(mcp.urlForRun("memory-run"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.text();
  const data = body.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(data ? data.slice(6) : body).result;
}
const tool = (name: string, args: object) => mcpRequest("tools/call", { name, arguments: args });
it("passes memory paging and filters through the RPC and rejects invalid offsets", async () => {
  const first = memories.upsert(core.db, { projectId, type: "command", title: "First command", body: "pnpm test", source: "user" }).memory;
  const second = memories.upsert(core.db, { projectId, type: "command", title: "Second command", body: "pnpm build", source: "user" }).memory;
  core.db.stmt("UPDATE memories SET updated_at = 1000 WHERE id = ?").run(first.id);
  core.db.stmt("UPDATE memories SET updated_at = 2000 WHERE id = ?").run(second.id);
  const input = { projectId, types: ["command" as const], sources: ["user" as const], limit: 1 };
  expect(await rpc("memory.list", input)).toMatchObject({ type: "rpc.result", result: [{ id: second.id }] });
  expect(await rpc("memory.list", { ...input, offset: 1 })).toMatchObject({ type: "rpc.result", result: [{ id: first.id }] });
  expect(await rpc("memory.list", { ...input, offset: 2 })).toMatchObject({ type: "rpc.result", result: [] });
  for (const offset of [-1, 0.5]) expect(await rpc("memory.list", { ...input, offset })).toMatchObject({ type: "rpc.error" });
});

it("enforces a renderer-saved Off across real MCP reads, writes and feedback while preserving user browsing", async () => {
  expect(await rpc("memory.settings.set", { enabled: false })).toMatchObject({ type: "rpc.result", result: { enabled: false } });
  const catalog = await mcpRequest("tools/list");
  expect(catalog.tools.some((tool: { name: string }) => tool.name.startsWith("memory_"))).toBe(false);
  expect(catalog.tools.some((tool: { name: string }) => tool.name === "task_context")).toBe(true);
  for (const [name, args] of [
    ["memory_search", { query: "fixture" }],
    ["memory_record", { type: "lesson", title: "Unexpected memory", body: "Must not save" }],
    ["memory_feedback", { id: memoryId, verdict: "helpful" }],
  ] as const) {
    const result = await tool(name, args);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/not found/);
  }
  expect(memories.list(core.db, { projectId })).toHaveLength(1);
  expect(await rpc("memory.search", { projectId, query: "fixture" })).toMatchObject({ type: "rpc.result", result: [{ id: memoryId }] });
  expect(await rpc("memory.update", { projectId, id: memoryId, patch: { title: "Corrected fixture" } })).toMatchObject({ type: "rpc.result", result: { title: "Corrected fixture" } });
  expect(await rpc("memory.settings.set", { enabled: true, provider: "off" })).toMatchObject({ type: "rpc.result", result: { enabled: true, provider: "off" } });
  expect((await mcpRequest("tools/list")).tools.filter((tool: { name: string }) => tool.name.startsWith("memory_"))).toHaveLength(3);
  expect((await tool("memory_record", { type: "lesson", title: "Allowed memory", body: "Explicit agent save" })).isError).not.toBe(true);
  expect(memories.list(core.db, { projectId })).toHaveLength(2);
});
