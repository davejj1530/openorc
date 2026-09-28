import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { AcpAdapter } from "./adapter.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

/** The real ACP client talks to a model-dependent catalog over the process pipes. */
function catalog(failModel?: string) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(), kill: vi.fn() });
  vi.mocked(spawn).mockReturnValue(proc as unknown as ChildProcess);
  const requests: { method: string; params: Record<string, string> }[] = [];
  let selected = "provider/reasoner";
  const options = () => [
    {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: selected,
      options: [
        { value: "provider/reasoner", name: "Provider/Reasoner" },
        { value: "provider/custom", name: "Provider/Custom" },
        { value: "provider/plain", name: "Provider/Plain" },
      ],
    },
    ...(selected === "provider/plain"
      ? []
      : [
          {
            id: "effort",
            name: "Effort",
            type: "select",
            currentValue: "default",
            options: (selected === "provider/custom" ? ["deep-analysis", "default"] : ["low", "high", "default"]).map((value) => ({ value, name: value })),
          },
        ]),
  ];
  let buffer = "";
  stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines.filter(Boolean)) {
      const request = JSON.parse(line);
      requests.push(request);
      if (request.method === "session/set_config_option") selected = request.params.value;
      if (request.method === "session/set_config_option" && selected === failModel) {
        stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "Discovery failed" } })}\n`);
        continue;
      }
      const result =
        request.method === "initialize" ? { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Fixture", version: "1" } } : { sessionId: "catalog-session", configOptions: options() };
      stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    }
  });
  return { adapter: new AcpAdapter({ onApproval: async () => "deny" }), requests, proc };
}

describe("OpenCode model discovery", () => {
  it("reads each model's own efforts, preserves custom variants and leaves models with none empty", async () => {
    const { adapter, requests, proc } = catalog();
    const models = await adapter.listModels();
    expect(models).toMatchObject([
      { id: "provider/reasoner", isDefault: true, efforts: ["low", "high", "default"], defaultEffort: "default" },
      { id: "provider/custom", isDefault: false, efforts: ["deep-analysis", "default"], defaultEffort: "default" },
      { id: "provider/plain", isDefault: false, efforts: [], defaultEffort: null },
    ]);
    expect(requests.some((r) => r.method === "session/prompt")).toBe(false);
    expect(requests.at(-1)).toMatchObject({ method: "session/delete", params: { sessionId: "catalog-session" } });
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
