import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projects, runs, tasks, threads } from "@openorc/db";
import { DeviceMachine } from "./devices/fixtures/device-machine.js";
import { OpenOrc } from "./openorc.js";
import { rpcClient } from "./rpc-test-client.js";
import type { Broadcast } from "./transport.js";

let core: OpenOrc;
let dir: string;
let machine: DeviceMachine;
let pushes: Broadcast[];
let threadId: string;
const rpc = rpcClient(() => core);

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "openorc-device-rpc-test-"));
  machine = await new DeviceMachine(path.join(dir, "machine")).setup();
  pushes = [];
  core = await OpenOrc.create({ dataDir: path.join(dir, "data"), ephemeral: true, transport: { push: (message) => pushes.push(message) }, deviceSystem: machine.system });
  vi.spyOn(core.environment, "current").mockReturnValue(machine.snapshot());
  const project = projects.insert(core.db, { name: "Devices", rootPath: dir, gitRemote: null, defaultBranch: null, settings: {} });
  threadId = threads.insert(core.db, { projectId: project.id, title: "App", agent: "codex", model: null, mode: "act", permissionMode: "trusted" }).id;
  runs.insert(core.db, { id: "act-run", threadId, taskId: null, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  runs.insert(core.db, { id: "plan-run", threadId, taskId: null, agent: "codex", model: null, mode: "plan", permissionMode: "trusted" });
  vi.spyOn(core.runs, "isLive").mockImplementation((id) => runs.get(core.db, id) !== null);
  vi.spyOn(core.runs, "isBusy").mockReturnValue(true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await core.close();
  await machine.close();
  await rm(dir, { recursive: true, force: true });
});

type ToolResult = { isError?: boolean; content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] };

async function device(runId: string, args: object): Promise<ToolResult> {
  const mcp = await core.mcpServer();
  const response = await fetch(mcp.urlForRun(runId), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "device", arguments: args } }),
  });
  const text = await response.text();
  const data = text.split("\n").find((line) => line.startsWith("data: "));
  return (JSON.parse(data ? data.slice(6) : text) as { result: ToolResult }).result;
}

const text = (result: ToolResult) => (result.content[0]?.type === "text" ? result.content[0].text : "");
const json = (result: ToolResult) => JSON.parse(text(result)) as Record<string, unknown>;
const panelPushes = () => pushes.filter((push) => push.type === "device.panel");
const hubCalls = async () => (machine.system.hubs.length ? (await machine.system.hubs[0]!.hub).calls : []);

describe("device RPCs", () => {
  it("report status, set up support and list devices", async () => {
    expect(await rpc("devices.status", {})).toMatchObject({ settings: { enabled: false, agentAccess: true }, helpers: { phase: "off" }, blocked: null });
    expect(await rpc("devices.setup", { agentAccess: true })).toMatchObject({ settings: { enabled: true }, helpers: { phase: "running" } });
    expect((await rpc("devices.list", {})).devices.map((item) => item.id)).toEqual(["IPHONE-17", "IPAD-AIR"]);
    await expect(rpc("devices.boot", { deviceId: "NOPE" })).rejects.toThrow("That device is no longer available.");
  });
});

describe("the device tool", () => {
  it("tells the agent to ask the user while device support is off", async () => {
    const result = await device("act-run", { action: "list" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Device support is off. Ask the user to turn it on in the Device panel.");
  });

  it("tells the agent where the user turns agent access on", async () => {
    await rpc("devices.setup", { agentAccess: false });
    const result = await device("act-run", { action: "open", platform: "ios" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Agent device access is off. The user can turn it on in Settings, Devices; it applies to conversations started after that.");
    expect(panelPushes()).toEqual([]);
  });

  it("opens a device for the conversation and returns how to drive it", async () => {
    await rpc("devices.setup", { agentAccess: true });
    const result = json(await device("act-run", { action: "open", platform: "ios" }));
    const devicesDir = path.join(dir, "data", "devices");
    expect(result).toMatchObject({
      action: "open",
      device: { id: "IPAD-AIR", state: "booted" },
      command: path.join(devicesDir, "bin", "agent-device"),
      args: ["--platform", "ios", "--udid", "IPAD-AIR", "--config", path.join(devicesDir, "agent-device", "config.json"), "--session", expect.stringMatching(/^openorc-[0-9a-f]{16}$/)],
    });
    expect(result["howTo"]).toContain("iPad Air (iOS 26.5)");
    expect(panelPushes()).toEqual([{ type: "device.panel", surface: `thread:${threadId}`, deviceId: "IPAD-AIR", name: "iPad Air", action: "open" }]);
    expect(json(await device("act-run", { action: "list" }))).toMatchObject({ open: ["IPAD-AIR"] });
  });

  it("boots a shut-down device through the hub without waiting for its stream", async () => {
    await rpc("devices.setup", { agentAccess: true });
    expect(json(await device("act-run", { action: "open", deviceId: "IPHONE-17" }))).toMatchObject({ action: "open", device: { id: "IPHONE-17" } });
    expect((await hubCalls()).filter((call) => call.method === "POST").map((call) => call.path)).toEqual(["/api/devices/boot"]);
  });

  it("lets Plan mode look but not open or close devices", async () => {
    await rpc("devices.setup", { agentAccess: true });
    await device("act-run", { action: "open", deviceId: "IPAD-AIR" });
    const before = panelPushes().length;

    expect(json(await device("plan-run", { action: "list" }))).toMatchObject({ action: "list", open: ["IPAD-AIR"] });
    const shot = await device("plan-run", { action: "screenshot" });
    expect(json(shot)).toMatchObject({ action: "screenshot", device: { id: "IPAD-AIR" } });
    expect(shot.content[1]).toMatchObject({ type: "image", mimeType: "image/png", data: expect.any(String) });

    const blocked = "Opening and closing devices is blocked in Plan mode. Use list and screenshot, and put the steps in the plan.";
    for (const args of [
      { action: "open", deviceId: "IPHONE-17" },
      { action: "close", shutdown: true },
    ]) {
      const result = await device("plan-run", args);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain(blocked);
    }
    expect(panelPushes()).toHaveLength(before);
    expect((await hubCalls()).filter((call) => call.path.includes("boot") || call.path.includes("shutdown"))).toEqual([]);
  });

  it("closes the device it opened, and shuts it down only when asked", async () => {
    await rpc("devices.setup", { agentAccess: true });
    await device("act-run", { action: "open", deviceId: "IPAD-AIR" });
    expect(json(await device("act-run", { action: "close" }))).toEqual({ action: "close", deviceId: "IPAD-AIR", shutdown: false });
    expect(panelPushes().at(-1)).toMatchObject({ action: "close", deviceId: "IPAD-AIR" });
    expect((await hubCalls()).filter((call) => call.path.includes("shutdown"))).toEqual([]);
    expect(text(await device("act-run", { action: "screenshot" }))).toContain("No device is open in this conversation.");

    await device("act-run", { action: "open", deviceId: "IPAD-AIR" });
    expect(json(await device("act-run", { action: "close", shutdown: true }))).toMatchObject({ shutdown: true });
    expect((await hubCalls()).filter((call) => call.path.includes("shutdown")).map((call) => call.path)).toEqual(["/vendor/serve-sim/grid/api/shutdown"]);
  });

  it("acts in the run's own conversation and refuses runs that have none", async () => {
    await rpc("devices.setup", { agentAccess: true });
    const thread = threads.get(core.db, threadId)!;
    const task = tasks.insert(core.db, { projectId: thread.projectId, title: "T", spec: "", priority: "none", labels: [], workspaceMode: "current", baseRef: null, parentTaskId: null });
    runs.insert(core.db, { id: "task-run", threadId: null, taskId: task.id, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    await device("task-run", { action: "open", deviceId: "IPAD-AIR" });
    expect(panelPushes().at(-1)).toMatchObject({ surface: `task:${task.id}` });

    expect(text(await device("act-run", { action: "list", surface: "thread:other" }))).toContain("Unrecognized key");
    vi.mocked(core.runs.isBusy).mockReturnValue(false);
    expect(text(await device("act-run", { action: "list" }))).toContain("Device access requires an active conversation turn.");
  });

  it("puts the shim on new runs' PATH while agents have access", async () => {
    const hooks = (core.runs as unknown as { hooks: { environment(): { path: string } } }).hooks;
    const bin = path.join(dir, "data", "devices", "bin");
    expect(hooks.environment().path).toBe(machine.bin);
    await rpc("devices.setup", { agentAccess: true });
    expect(hooks.environment().path).toBe(`${bin}${path.delimiter}${machine.bin}`);
    await rpc("devices.settings.set", { agentAccess: false });
    expect(hooks.environment().path).toBe(machine.bin);
  });
});
