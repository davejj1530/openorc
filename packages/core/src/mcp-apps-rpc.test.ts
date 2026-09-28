import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { CodexAdapter, RunHandle } from "@openorc/agents";
import { completedToolCall, threads } from "@openorc/db";
import { git, commitAll } from "@openorc/git";
import type { AgentEvent, Project, RunMode, McpAppConnection } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";

let root: string, dataDir: string, core: OpenOrc, project: Project;
const live: string[] = [];
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-mcp-apps-repo-"));
  dataDir = await mkdtemp(path.join(os.tmpdir(), "openorc-mcp-apps-data-"));
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(path.join(root, "README.md"), "# MCP Apps test\n");
  await commitAll(root, "init");
  core = await OpenOrc.create({ dataDir, ephemeral: true, transport: { push() {} } });
  project = await core.projects.import(root);
});
afterEach(async () => {
  await Promise.all(live.splice(0).map((id) => core.runs.closeAndWait(id)));
  vi.restoreAllMocks();
});
afterAll(async () => {
  await core.close();
  await rm(root, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

async function session(mode: RunMode = "act") {
  const events: AgentEvent[] = [];
  const connection: McpAppConnection = {
    listTools: vi.fn(async () => [{ name: "show", inputSchema: { type: "object" }, _meta: { ui: { resourceUri: "ui://weather" } } }, { name: "refresh" }]),
    readResource: vi.fn(async () => ({ contents: [{ uri: "ui://weather", mimeType: "text/html;profile=mcp-app", text: "<h1>Weather</h1>" }] })),
    callTool: vi.fn(async () => ({ content: [] })),
  };
  const thread = threads.insert(core.db, { projectId: project.id, title: "Apps", agent: "codex", model: "fixture", mode, permissionMode: "trusted" });
  vi.spyOn(CodexAdapter.prototype, "start").mockImplementation((spec) => {
    let finish!: (code: number) => void;
    const done = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const handle = new RunHandle(spec.runId, {
      mcpApps: connection,
      interrupt() {},
      send: async () => {},
      close() {
        handle.emit("exit", 0);
        finish(0);
      },
      done,
    });
    return handle;
  });
  const run = await core.runs.start({ scope: { thread, task: null }, project, agent: "codex", model: "fixture", mode, permissionMode: "trusted", prompt: "Work", resume: false });
  live.push(run.id);
  core.ledger.push({
    type: "tool.completed",
    runId: run.id,
    ts: 1,
    toolCallId: "weather",
    name: "weather.show",
    mcp: { server: "weather", tool: "show" },
    input: { city: "Manila" },
    output: { content: [{ type: "text", text: "x".repeat(10000) }] },
    isError: false,
  });
  const emit = core.ledger.push.bind(core.ledger);
  vi.spyOn(core.ledger, "push").mockImplementation((event) => {
    events.push(event);
    emit(event);
  });
  return { run, connection, events };
}
it("loads an artifact-backed persisted call and sends app actions through real approval cards", async () => {
  const { run, connection, events } = await session();
  const app = await core.runs.mcpApps.open(run.id, "weather");
  if (app.status !== "ready") throw new Error(JSON.stringify(app));
  core.ledger.flush();
  expect(completedToolCall(core.db, run.id, "weather")?.mcp).toEqual({ server: "weather", tool: "show", resourceUri: "ui://weather" });
  expect(completedToolCall(core.db, "another-run", "weather")).toBeUndefined();
  const action = core.runs.mcpApps.callTool(app.viewId, "refresh", { day: 2 });
  const approval = events.find((e) => e.type === "approval.requested");
  if (!approval || approval.type !== "approval.requested") throw new Error("No approval requested");
  expect(connection.callTool).not.toHaveBeenCalled();
  core.runs.resolveApproval(run.id, approval.approvalId, "allow");
  await action;
  expect(connection.callTool).toHaveBeenCalledWith("weather", "refresh", { day: 2 });
  expect(events).toContainEqual(expect.objectContaining({ type: "approval.resolved", approvalId: approval.approvalId, decision: "allow" }));
});
it("closing a view cancels its pending approval before any tool executes", async () => {
  const { run, connection } = await session();
  const app = await core.runs.mcpApps.open(run.id, "weather");
  if (app.status !== "ready") throw new Error("Missing app");
  const action = core.runs.mcpApps.callTool(app.viewId, "refresh", {});
  core.runs.mcpApps.close(app.viewId);
  await expect(action).rejects.toThrow("not approved");
  expect(core.runs.threadActivity(run.threadId!)).not.toBe("waiting");
  expect(connection.callTool).not.toHaveBeenCalled();
});
it("Plan sessions never grant an interactive app a connection", async () => {
  const { run, connection } = await session("plan");
  expect(await core.runs.mcpApps.open(run.id, "weather")).toMatchObject({ status: "none" });
  expect(connection.listTools).not.toHaveBeenCalled();
  expect(connection.readResource).not.toHaveBeenCalled();
});
