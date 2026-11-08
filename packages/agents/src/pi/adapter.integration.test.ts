import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentEvent, type ApprovalResolution, type RunSpec } from "@openorc/protocol";
import type { AgentLaunchEnvironment } from "../launch-environment.js";
import { LiveInputUnavailable, type RunHandle } from "../run-handle.js";
import { PiAdapter } from "./adapter.js";
import { listPiModels } from "./models.js";
import { listPiSkills } from "./skills.js";
import { piConnectorDriver } from "./connectors.js";

const binary = process.env["OPENORC_TEST_PI_BIN"];
const requestBody = z.object({
  model: z.string(),
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
  tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional(),
});

/** The real CLI against a local OpenAI-compatible endpoint; no account, external connection or bill. */
describe.skipIf(!binary)("Pi CLI integration", () => {
  let root: string;
  let server: Server;
  let launch: AgentLaunchEnvironment;
  const handles: RunHandle[] = [];
  const responses = new Set<ServerResponse>();
  let toolCalls: string[];
  let requests: unknown[];
  let mcpUrl: string;
  let releaseResponse: () => void;
  let providerError: { status: number; message: string } | null;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-pi-test-")));
    await mkdir(path.join(root, "agent"));
    await mkdir(path.join(root, "project"));
    toolCalls = [];
    requests = [];
    providerError = null;
    releaseResponse = () => {};
    const serve = async (request: IncomingMessage, response: ServerResponse) => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      if (request.url === "/mcp") {
        if (request.method !== "POST") {
          response.writeHead(405).end();
          return;
        }
        const rpc = z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string(), params: z.unknown().optional() }).parse(JSON.parse(body));
        if (rpc.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        if (rpc.method === "tools/call") toolCalls.push("ping");
        let result: unknown = { content: [{ type: "text", text: "pong" }] };
        if (rpc.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
        if (rpc.method === "tools/list") result = { tools: [{ name: "ping", description: "Read a fixture value", inputSchema: { type: "object", properties: {} } }] };
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
        return;
      }
      requests.push(JSON.parse(body));
      if (providerError) {
        response.writeHead(providerError.status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: providerError.message, type: "provider_error" } }));
        return;
      }
      const data = requestBody.parse(JSON.parse(body));
      const userIndex = data.messages.findLastIndex((message) => message.role === "user");
      const prompt = JSON.stringify(data.messages[userIndex]?.content);
      responses.add(response);
      response.once("close", () => responses.delete(response));
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (prompt.includes("wait forever")) {
        response.write(": waiting\n\n");
        return;
      }
      const usesTool = /write a file|use mcp/.test(prompt) && !data.messages.slice(userIndex).some((message) => message.role === "tool");
      const toolName = prompt.includes("use mcp") ? data.tools?.find((tool) => tool.function.name.includes("ping"))?.function.name : "write";
      const delta = usesTool
        ? {
            tool_calls: [
              {
                index: 0,
                id: `call_${requests.length}`,
                type: "function",
                function: { name: toolName, arguments: JSON.stringify(toolName === "write" ? { path: "result.txt", content: "fixture result" } : {}) },
              },
            ],
          }
        : { content: "Hello\u2028from Pi" };
      const chunk = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
      const common = { id: `reply_${requests.length}`, object: "chat.completion.chunk", created: 1, model: "fixture-model" };
      chunk({ ...common, choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] });
      const finish = () => {
        chunk({ ...common, choices: [{ index: 0, delta: {}, finish_reason: usesTool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } });
        response.end("data: [DONE]\n\n");
      };
      if (prompt.includes("wait for steering")) releaseResponse = finish;
      else finish();
    };
    server = createServer((request, response) => {
      void serve(request, response).catch(() => response.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture did not open a port.");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    mcpUrl = `${baseUrl}/mcp`;
    await writeFile(
      path.join(root, "agent", "models.json"),
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl,
            api: "openai-completions",
            apiKey: "fixture",
            models: [
              { id: "fixture-model", name: "Fixture model", reasoning: false, contextWindow: 32000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
              { id: "reasoning-model", name: "Reasoning model", reasoning: true, contextWindow: 32000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
            ],
          },
        },
      }),
    );
    launch = { binary: binary!, revision: 1, env: { PATH: process.env["PATH"], HOME: root, PI_CODING_AGENT_DIR: path.join(root, "agent"), PI_OFFLINE: "1" } };
  });

  afterEach(async () => {
    for (const handle of handles.splice(0)) {
      handle.close();
      await handle.wait();
    }
    for (const response of responses) response.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  function start(patch: Partial<RunSpec> = {}, onApproval = vi.fn(async (): Promise<ApprovalResolution> => ({ decision: "allow" }))) {
    const handle = new PiAdapter({ onApproval }).start(
      { runId: `pi-${handles.length}`, agent: "pi", cwd: path.join(root, "project"), prompt: "hello", model: "fixture/fixture-model", permissionMode: "autonomous", ...patch },
      launch,
    );
    handles.push(handle);
    const events: AgentEvent[] = [];
    handle.on("event", (event) => events.push(AgentEvent.parse(event)));
    return { handle, events, onApproval };
  }

  it("discovers authenticated models, streams Unicode text, and resumes the native session", async () => {
    const models = await listPiModels(launch);
    expect(models).toEqual(expect.arrayContaining([expect.objectContaining({ id: "fixture/fixture-model", agent: "pi", efforts: [] })]));
    expect(requests).toHaveLength(0);
    const { handle, events } = start();
    const session = await handle.next("session.started", 15000);
    expect(await handle.next("turn.completed", 15000)).toMatchObject({ status: "success", resultText: "Hello\u2028from Pi", usage: { inputTokens: 20, outputTokens: 5 } });
    expect(events.some((event) => event.type === "message.delta")).toBe(true);
    await handle.send("follow up");
    expect(await handle.next("turn.completed", 15000)).toMatchObject({ status: "success" });
    handle.close();
    await handle.wait();
    const resumed = start({ resumeSessionId: session.externalSessionId!, prompt: "continue" }).handle;
    expect((await resumed.next("session.started", 15000)).externalSessionId).toBe(session.externalSessionId);
    expect(await resumed.next("turn.completed", 15000)).toMatchObject({ status: "success" });
    expect(JSON.stringify(requests.at(-1))).toContain("follow up");
  }, 30000);

  it.each([
    { status: 401, message: "Please log in to continue.", kind: "sign_in" },
    { status: 400, message: "insufficient_quota", kind: "usage" },
  ])(
    "keeps $kind recovery on a failed provider response and resumes after it is fixed",
    async ({ status, message, kind }) => {
      providerError = { status, message };
      const { handle, events } = start();
      expect(await handle.next("turn.completed", 15000)).toMatchObject({ status: "error" });
      expect(events.find((event) => event.type === "activity.updated" && event.label === "Provider error")).toMatchObject({ recovery: { kind, provider: "pi" } });
      providerError = null;
      await handle.send("Try again");
      expect(await handle.next("turn.completed", 15000)).toMatchObject({ status: "success" });
    },
    30000,
  );

  it("changes model and effort without restarting, keeps usage attributed to each model and rejects unsupported choices before sending", async () => {
    const { handle, events } = start();
    await handle.next("session.started", 15000);
    const first = await handle.next("turn.completed", 15000);
    expect(first.usage?.model).toBe("fixture/fixture-model");
    expect(handle.canApplySettings).toBe(true);
    await expect(handle.applySettings({ model: "fixture/missing" })).rejects.toThrow("cannot run");
    await expect(handle.applySettings({ model: "fixture/reasoning-model", effort: "impossible" })).rejects.toThrow("does not offer");
    expect(requests).toHaveLength(1);
    await handle.applySettings({ model: "fixture/reasoning-model", effort: "low", fastMode: false });
    await handle.send("Use the new model");
    expect(await handle.next("turn.completed", 15000)).toMatchObject({ status: "success", usage: { model: "fixture/reasoning-model", inputTokens: 40, outputTokens: 10 } });
    expect(requestBody.parse(requests.at(-1)).model).toBe("reasoning-model");
    expect(events.filter((event) => event.type === "session.started")).toHaveLength(1);
    expect(JSON.stringify(requests.at(-1))).toContain("Hello");
  }, 30000);

  it("waits for review approval before editing and respects a denial", async () => {
    let answer: (value: ApprovalResolution) => void = () => {};
    const onApproval = vi.fn(
      () =>
        new Promise<ApprovalResolution>((resolve) => {
          answer = resolve;
        }),
    );
    const { handle } = start({ prompt: "write a file", permissionMode: "review" }, onApproval);
    await vi.waitFor(() => expect(onApproval).toHaveBeenCalled(), { timeout: 15000 });
    await expect(readFile(path.join(root, "project", "result.txt"))).rejects.toThrow();
    const completed = handle.next("turn.completed", 15000);
    answer({ decision: "deny" });
    expect(await completed).toMatchObject({ status: "success" });
    await expect(readFile(path.join(root, "project", "result.txt"))).rejects.toThrow();
  }, 20000);

  it("allows edits in Accept edits and blocks them in Plan", async () => {
    const trusted = start({ prompt: "write a file", permissionMode: "trusted" });
    expect(await trusted.handle.next("turn.completed", 15000)).toMatchObject({ status: "success" });
    expect(trusted.onApproval).not.toHaveBeenCalled();
    expect(await readFile(path.join(root, "project", "result.txt"), "utf8")).toBe("fixture result");
    await rm(path.join(root, "project", "result.txt"));
    const plan = start({ prompt: "write a file", mode: "plan" });
    expect(await plan.handle.next("turn.completed", 15000)).toMatchObject({ status: "success" });
    expect(plan.onApproval).not.toHaveBeenCalled();
    await expect(readFile(path.join(root, "project", "result.txt"))).rejects.toThrow();
  }, 30000);

  it("connects OpenOrc's MCP server without writing the user's MCP configuration", async () => {
    const { handle, onApproval } = start({ prompt: "use mcp", internalMcp: { serverName: `openorc_${"a".repeat(32)}`, url: mcpUrl, toolNames: ["ping"] } });
    expect(await handle.next("turn.completed", 15000)).toMatchObject({ status: "success" });
    expect(toolCalls).toEqual(["ping"]);
    expect(onApproval).not.toHaveBeenCalled();
    await expect(readFile(path.join(root, "agent", "mcp.json"))).rejects.toThrow();
  }, 20000);

  it("cancels an active response and can receive another prompt", async () => {
    const { handle } = start({ prompt: "wait forever" });
    await vi.waitFor(() => expect(requests.length).toBe(1), { timeout: 15000 });
    const completed = handle.next("turn.completed", 15000);
    await handle.interrupt();
    expect(await completed).toMatchObject({ status: "cancelled" });
    await handle.send("hello again");
    expect(await handle.next("turn.completed", 15000)).toMatchObject({ status: "success" });
  }, 20000);

  it.each(["send", "steer"] as const)(
    "consumes live input through %s before settling the active turn",
    async (method) => {
      const { handle, events } = start({ prompt: "wait for steering" });
      await vi.waitFor(() => expect(requests.length).toBe(1), { timeout: 15000 });
      expect(handle.canSteer).toBe(true);
      if (method === "send") await handle.send("use this correction");
      else expect(await handle.steer("use this correction")).toBe("accepted");
      const completed = handle.next("turn.completed", 15000);
      releaseResponse();
      expect(await completed).toMatchObject({ status: "success" });
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests.at(-1))).toContain("use this correction");
      expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
      expect(await handle.steer("too late")).toBe("unavailable");
    },
    20000,
  );

  it("ignores a late approval after cancellation", async () => {
    let answer: (value: ApprovalResolution) => void = () => {};
    const onApproval = vi.fn(
      () =>
        new Promise<ApprovalResolution>((resolve) => {
          answer = resolve;
        }),
    );
    const { handle } = start({ prompt: "write a file", permissionMode: "review" }, onApproval);
    await vi.waitFor(() => expect(onApproval).toHaveBeenCalled(), { timeout: 15000 });
    expect(handle.canSteer).toBe(false);
    await expect(handle.send("Wait until the approval is resolved.")).rejects.toBeInstanceOf(LiveInputUnavailable);
    const completed = handle.next("turn.completed", 15000);
    await handle.interrupt();
    expect(await completed).toMatchObject({ status: "cancelled" });
    answer({ decision: "allow" });
    await handle.send("hello again");
    expect(await handle.next("turn.completed", 15000)).toMatchObject({ status: "success" });
    await expect(readFile(path.join(root, "project", "result.txt"))).rejects.toThrow();
  }, 20000);

  it("discovers native skills and manages Pi's own MCP configuration", async () => {
    const skill = path.join(root, "project", ".pi", "skills", "fixture");
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, "SKILL.md"), "---\nname: fixture\ndescription: A fixture skill\n---\nReturn the fixture result.");
    expect(await listPiSkills(path.join(root, "project"), launch)).toContainEqual({ name: "fixture", path: path.join(skill, "SKILL.md"), description: "A fixture skill", source: "project" });
    const connectors = piConnectorDriver(launch);
    await connectors.save("fixture", { kind: "url", url: mcpUrl, headers: {} });
    expect(await connectors.read(path.join(root, "project"))).toMatchObject([{ name: "fixture", status: "connected", source: "user" }]);
    await connectors.setOn?.("fixture", false);
    expect(await connectors.read(path.join(root, "project"))).toMatchObject([{ name: "fixture", status: "off" }]);
    await connectors.remove("fixture");
    expect(await connectors.spec("fixture")).toBeNull();
  }, 20000);

  it("forks a saved conversation into a distinct native session", async () => {
    const original = start();
    const session = await original.handle.next("session.started", 15000);
    await original.handle.next("turn.completed", 15000);
    original.handle.close();
    await original.handle.wait();
    const fork = start({ resumeSessionId: session.externalSessionId!, forkSession: true, prompt: "forked follow up" });
    expect((await fork.handle.next("session.started", 15000)).externalSessionId).not.toBe(session.externalSessionId);
    expect(await fork.handle.next("turn.completed", 15000)).toMatchObject({ status: "success" });
    expect(JSON.stringify(requests.at(-1))).toContain("Hello");
  }, 20000);
});
