import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AcpAdapter } from "../acp/adapter.js";
import { StdioJsonRpc } from "../jsonrpc.js";
import type { AgentLaunchEnvironment } from "../launch-environment.js";
import { stopProcess } from "../process-lifetime.js";
import { antigravityAcp } from "./acp.js";
import { antigravityConnectorDriver } from "./connectors.js";

const binary = process.env["OPENORC_TEST_ANTIGRAVITY_BIN"];
const session = z.object({ sessionId: z.string(), configOptions: z.array(z.object({ id: z.string(), currentValue: z.string() }).passthrough()) });

/** The actual CLI, isolated from real credentials. These tests configure sessions but never prompt a model. */
describe.skipIf(!binary)("Antigravity CLI integration", () => {
  let root: string;
  let launch: AgentLaunchEnvironment;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-antigravity-test-")));
    launch = { revision: 0, binary: binary!, env: { PATH: process.env["PATH"], HOME: root, GEMINI_API_KEY: "fixture-not-a-real-key" } };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("discovers Gemini models and each model's own thinking levels through OpenOrc's adapter", async () => {
    const models = await new AcpAdapter({ profile: antigravityAcp, modelsCwd: root, onApproval: async () => "deny" }).listModels(launch);
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => model.id.startsWith("gemini-") && model.provider.id === "antigravity")).toBe(true);
    expect(models.find((model) => model.id === "gemini-3.8-flash")?.efforts).toEqual(["low", "medium", "high"]);
    expect(models.find((model) => model.id === "gemini-3.1-pro")?.efforts).toEqual(["low", "high"]);
  });

  it("uses the native Plan setting and reopens a session without generating a model response", async () => {
    const requests: string[] = [];
    const serve = async (request: IncomingMessage, response: ServerResponse) => {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const message = z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string() }).parse(JSON.parse(body));
      requests.push(message.method);
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result = message.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } : { tools: [] };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    };
    const server = createServer((request, response) => {
      void serve(request, response).catch(() => response.writeHead(500).end());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("MCP fixture did not bind a port");
    const mcpServers = [{ type: "http", name: "openorc_fixture", url: `http://127.0.0.1:${address.port}/mcp`, headers: [] }];
    const proc = spawn(launch.binary, ["acp", "--process-per-session", "--disable-telemetry"], { cwd: root, env: { ...launch.env }, stdio: ["pipe", "pipe", "pipe"], detached: true });
    const closed = new Promise<void>((resolve) => proc.once("close", () => resolve()));
    const rpc = new StdioJsonRpc(proc, { includeJsonRpcField: true });
    try {
      await rpc.request("initialize", { protocolVersion: 1, clientInfo: { name: "openorc", version: "0.0.0" }, clientCapabilities: {} });
      await rpc.request("authenticate", { methodId: "gemini-api-key" });
      const created = session.parse(await rpc.request("session/new", { cwd: root, mcpServers }));
      await vi.waitFor(() => expect(requests).toContain("tools/list"));
      const changed = session.omit({ sessionId: true }).parse(await rpc.request("session/set_config_option", { sessionId: created.sessionId, configId: "mode", value: "plan" }));
      expect(changed.configOptions.find((option) => option.id === "mode")?.currentValue).toBe("plan");
      await rpc.request("session/close", { sessionId: created.sessionId });
      const loaded = session.omit({ sessionId: true }).parse(await rpc.request("session/load", { sessionId: created.sessionId, cwd: root, mcpServers: [] }));
      expect(loaded.configOptions.some((option) => option.id === "model")).toBe(true);
    } finally {
      stopProcess(proc);
      await closed;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("writes MCP settings the real CLI reads, preserves unrelated values, and reports configuration honestly", async () => {
    const driver = antigravityConnectorDriver(launch);
    const file = path.join(root, ".gemini/config/mcp_config.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ note: "keep", mcpServers: { fixture: { serverUrl: "https://example.com/old", timeout: 2000 } } }));
    await driver.save("fixture", { kind: "url", url: "https://example.com/mcp", headers: {} });
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ note: "keep", mcpServers: { fixture: { serverUrl: "https://example.com/mcp", timeout: 2000 } } });
    expect(await driver.read(root)).toMatchObject([{ name: "fixture", status: "configured", source: "user" }]);
    const proc = spawn(launch.binary, ["mcp", "list"], { cwd: root, env: { ...launch.env } });
    let output = "";
    proc.stdout.on("data", (data: Buffer) => {
      output += data.toString();
    });
    expect(await new Promise((resolve) => proc.on("close", resolve))).toBe(0);
    expect(output).toMatch(/fixture\s+http\s+enabled/);
    await driver.setOn?.("fixture", false);
    expect(await driver.read(root)).toMatchObject([{ name: "fixture", status: "off" }]);
    await driver.remove("fixture");
    expect(await driver.read(root)).toEqual([]);
  });
});
