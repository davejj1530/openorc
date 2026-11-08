import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { AgentLaunchEnvironment } from "../launch-environment.js";

const requestBody = z.object({ model: z.string(), messages: z.array(z.object({ role: z.string(), content: z.unknown().optional() }).passthrough()) }).passthrough();
export type FxFixtureRequest = z.infer<typeof requestBody>;

/** A local OpenAI-compatible endpoint. It never forwards requests or loads real credentials. */
export async function fxFixture(binary: string) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-fx-test-")));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  await mkdir(path.join(root, ".fx"));
  const requests: FxFixtureRequest[] = [];
  const mcpCalls: string[] = [];
  let respond = (body: FxFixtureRequest, response: ServerResponse): void => completion(response, body.model, "Fixture reply");
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      const body: unknown = JSON.parse(raw);
      if (request.url === "/mcp") {
        const rpc = z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string() }).parse(body);
        mcpCalls.push(rpc.method);
        if (rpc.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        let result: unknown = { tools: [{ name: "echo", description: "Read a fixture value", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] };
        if (rpc.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
        if (rpc.method === "tools/call") result = { content: [{ type: "text", text: "Profile connector result" }] };
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
        return;
      }
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      const parsed = requestBody.parse(body);
      requests.push(parsed);
      respond(parsed, response);
    })().catch(() => response.writeHead(500).end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind a port");
  const url = `http://127.0.0.1:${address.port}`;
  const provider = (model: string) => ({
    protocol: "openai-chat-completions",
    base_url: `${url}/v1`,
    auth: { type: "none" },
    model_metadata: { [model]: { context_window: 32768, max_output_tokens: 2048, supports_tool_use: true } },
  });
  const settings = {
    provider: "local",
    auto_upgrade: false,
    permission_mode: "ask",
    providers: { local: provider("fixture-model"), second: provider("other-model") },
    models: { local: "fixture-model", second: "other-model" },
  };
  await writeFile(path.join(root, ".fx/settings.json"), JSON.stringify(settings));
  const launch: AgentLaunchEnvironment = { revision: 0, binary, env: { HOME: root, PATH: process.env["PATH"], FX_AUTO_UPGRADE: "0", FX_SOUND: "0", NO_COLOR: "1" } };
  return {
    root,
    workspace,
    url,
    launch,
    requests,
    mcpCalls,
    settings,
    respond: (next: typeof respond) => {
      respond = next;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

function event(response: ServerResponse, value: unknown): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}
export function completion(response: ServerResponse, model: string, text: string): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  event(response, { id: "fixture", model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] });
  event(response, { id: "fixture", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  event(response, { id: "fixture", model, choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } });
  response.end("data: [DONE]\n\n");
}
export function toolCompletion(response: ServerResponse, model: string, name: string, args: unknown): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  event(response, {
    id: "fixture",
    model,
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-fixture", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }],
  });
  event(response, { id: "fixture", model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  response.end("data: [DONE]\n\n");
}
