import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { projects, threads, runs, tasks } from "@openorc/db";
import { OpenOrc } from "./openorc.js";

let core: OpenOrc;
let dir: string;
let threadId: string;
const browser = vi.fn(async () => ({ url: "http://localhost:4321/", title: "Preview" }));
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "openorc-browser-test-"));
  core = await OpenOrc.create({ dataDir: dir, ephemeral: true, browser, transport: { push() {} } });
  const project = projects.insert(core.db, { name: "Browser test", rootPath: dir, gitRemote: null, defaultBranch: null, settings: {} });
  threadId = threads.insert(core.db, { projectId: project.id, title: "Preview", agent: "codex", model: null, mode: "act", permissionMode: "trusted" }).id;
  runs.insert(core.db, { id: "preview-run", threadId, taskId: null, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  browser.mockClear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await core.close();
  await rm(dir, { recursive: true, force: true });
});
async function call(runId: string, args: object) {
  const mcp = await core.mcpServer();
  const response = await fetch(mcp.urlForRun(runId), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser", arguments: args } }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
  const data = text.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(data ? data.slice(6) : text).result;
}

it("derives the preview from an active run and rejects caller-supplied conversation identity", async () => {
  vi.spyOn(core.runs, "isLive").mockImplementation((id) => runs.get(core.db, id) !== null);
  vi.spyOn(core.runs, "isBusy").mockReturnValue(true);
  expect((await call("preview-run", { action: "open", url: "http://localhost:4321" })).isError).not.toBe(true);
  expect(browser).toHaveBeenCalledExactlyOnceWith(`thread:${threadId}`, { action: "open", url: "http://localhost:4321" });
  expect((await call("preview-run", { action: "snapshot", surface: "thread:other" })).isError).toBe(true);
  expect(browser).toHaveBeenCalledTimes(1);
});

it("rejects stopped and missing runs even when their old MCP URL is known", async () => {
  await expect(call("preview-run", { action: "snapshot" })).rejects.toThrow("HTTP 404: unknown run");
  vi.spyOn(core.runs, "isLive").mockImplementation((id) => runs.get(core.db, id) !== null);
  vi.spyOn(core.runs, "isBusy").mockReturnValue(true);
  await expect(call("missing", { action: "snapshot" })).rejects.toThrow("HTTP 404: unknown run");
  expect(browser).not.toHaveBeenCalled();
});

it("routes task runs back to their owning conversation", async () => {
  const thread = threads.get(core.db, threadId)!;
  const task = tasks.insert(core.db, {
    projectId: thread.projectId,
    title: "Task preview",
    spec: "Check UI",
    priority: "none",
    labels: [],
    workspaceMode: "current",
    baseRef: null,
    parentTaskId: null,
  });
  tasks.update(core.db, task.id, { threadId });
  runs.insert(core.db, { id: "task-preview-run", threadId: null, taskId: task.id, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  vi.spyOn(core.runs, "isLive").mockImplementation((id) => runs.get(core.db, id) !== null);
  vi.spyOn(core.runs, "isBusy").mockReturnValue(true);
  expect((await call("task-preview-run", { action: "snapshot" })).isError).not.toBe(true);
  expect(browser).toHaveBeenCalledWith(`thread:${threadId}`, { action: "snapshot" });
});
