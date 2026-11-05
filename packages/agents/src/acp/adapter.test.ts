import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, ApprovalDecision, PermissionPreset, RunSpec } from "@openorc/protocol";
import { AcpAdapter, modelsFrom, type AcpApprovalRequest } from "./adapter.js";

const launch = { revision: 0, binary: "opencode", env: process.env };

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

type Request = { id: number; method: string; params: Record<string, unknown> };

/** A scripted ACP agent on the far side of the pipes; the adapter and the SDK client run unchanged. */
function agent(
  permissionMode: PermissionPreset = "autonomous",
  overrides: Partial<RunSpec> = {},
  decide: (request: AcpApprovalRequest) => Promise<ApprovalDecision> = async () => "allow",
  place: Parameters<AcpAdapter["start"]>[1] = launch,
) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 4242,
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: () => {
      proc.exitCode = 0;
      proc.emit("exit", 0);
      proc.emit("close", 0);
      return true;
    },
  });
  vi.mocked(spawn).mockReturnValue(proc as unknown as ChildProcess);
  const calls: Request[] = [];
  const notifications: { method: string; params: Record<string, unknown> }[] = [];
  const write = (message: unknown) => stdout.write(`${JSON.stringify(message)}\n`);
  const update = (sessionId: string, body: Record<string, unknown>) => write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: body } });
  /** Prompts waiting for the script to end them, by JSON-RPC id. */
  const prompts: number[] = [];
  let permissionId = 100;
  const permissions: { id: number; resolve: (response: unknown) => void }[] = [];
  const configOptions = [
    {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "openrouter/acme/fast",
      options: [
        { value: "openrouter/acme/fast", name: "OpenRouter/Acme Fast" },
        { value: "opencode/big", name: "opencode/Big" },
      ],
    },
    {
      id: "effort",
      name: "Effort",
      type: "select",
      currentValue: "default",
      options: [
        { value: "default", name: "Default" },
        { value: "high", name: "High" },
      ],
    },
  ];
  let buffer = "";
  stdin.on("data", (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown };
      if (message.method && message.id === undefined) {
        notifications.push({ method: message.method, params: message.params ?? {} });
        if (message.method === "session/cancel" && message.params?.["sessionId"] === "ses_1") {
          const id = prompts.shift();
          if (id !== undefined) write({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
        }
        continue;
      }
      if (message.method && message.id !== undefined) {
        const request = { id: message.id, method: message.method, params: message.params ?? {} };
        calls.push(request);
        const reply = (result: unknown) => write({ jsonrpc: "2.0", id: request.id, result });
        switch (request.method) {
          case "initialize":
            reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } }, agentInfo: { name: "Scripted", version: "1" } });
            break;
          case "session/new":
            reply({ sessionId: "ses_1", configOptions });
            break;
          case "session/resume":
            reply({ configOptions });
            break;
          case "session/set_config_option":
            reply({ configOptions: configOptions.map((option) => (option.id === request.params["configId"] ? { ...option, currentValue: request.params["value"] } : option)) });
            break;
          case "session/prompt":
            prompts.push(request.id);
            break;
          default:
            reply({});
        }
        continue;
      }
      // A response to one of the agent's own requests: a permission answer.
      const pending = permissions.find((entry) => entry.id === message.id);
      if (pending) pending.resolve(message.result);
    }
  });
  const events: AgentEvent[] = [];
  const handle = new AcpAdapter({ onApproval: decide }).start(
    {
      runId: "run-1",
      agent: "opencode",
      cwd: "/repo",
      prompt: "Hello",
      permissionMode,
      internalMcp: { serverName: "openorc_0123456789abcdef0123456789abcdef", url: "http://127.0.0.1:1/mcp", toolNames: ["task_create", "ask_user"] },
      ...overrides,
    },
    place,
  );
  handle.on("event", (event) => events.push(event));
  const finish = (result: Record<string, unknown> = { stopReason: "end_turn" }) => {
    const id = prompts.shift();
    if (id === undefined) throw new Error("no prompt in flight");
    write({ jsonrpc: "2.0", id, result });
  };
  const askPermission = (
    toolCall: Record<string, unknown>,
    options = [
      { optionId: "once", kind: "allow_once", name: "Allow once" },
      { optionId: "always", kind: "allow_always", name: "Always allow" },
      { optionId: "reject", kind: "reject_once", name: "Reject" },
    ],
    sessionId = "ses_1",
  ) =>
    new Promise<unknown>((resolve) => {
      const id = ++permissionId;
      permissions.push({ id, resolve });
      write({ jsonrpc: "2.0", id, method: "session/request_permission", params: { sessionId, toolCall, options } });
    });
  const fail = (message: string) => {
    const id = prompts.shift();
    if (id === undefined) throw new Error("no prompt in flight");
    write({ jsonrpc: "2.0", id, error: { code: -32603, message } });
  };
  const promptCalls = () => calls.filter((call) => call.method === "session/prompt");
  return { calls, notifications, events, handle, finish, fail, update, write, askPermission, promptCalls, proc };
}

const eventTypes = (events: AgentEvent[]) => events.map((event) => event.type);

describe("AcpAdapter", () => {
  it("keeps child permissions separate from the parent's cancellation", async () => {
    const requests: AcpApprovalRequest[] = [];
    const s = agent("autonomous", {}, async (request) => {
      requests.push(request);
      return new Promise(() => {});
    });
    try {
      await vi.waitFor(() => expect(s.promptCalls()).toHaveLength(1));
      s.write({
        jsonrpc: "2.0",
        method: "opencode/session/child_update",
        params: { rootSessionId: "ses_1", childSessionId: "a", parentSessionId: "ses_1", title: "A", type: "status", status: "created" },
      });
      let answered = false;
      const pending = s.askPermission({ toolCallId: "read", title: "Read file", kind: "read" }, undefined, "a").then((answer) => {
        answered = true;
        return answer;
      });
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      expect(requests[0]).toMatchObject({ subagentId: "a" });
      await s.handle.interrupt();
      await vi.waitFor(() => expect(s.events.some((e) => e.type === "turn.completed")).toBe(true));
      expect(answered).toBe(false);
      await s.handle.stopSubagent("a");
      await expect(pending).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    } finally {
      s.handle.close();
    }
  });
  it.each(["A", "B", "C", "D"])("routes recorded OpenCode child traffic %s into its own transcript", async (fixture) => {
    const s = agent();
    try {
      await vi.waitFor(() => expect(s.promptCalls()).toHaveLength(1));
      const frames = JSON.parse(readFileSync(new URL(`./test-fixtures/subagents-${fixture}.json`, import.meta.url), "utf8")) as { finish?: Record<string, unknown> }[];
      for (const frame of frames) {
        if (frame.finish) s.finish(frame.finish);
        else s.write(frame);
      }
      await vi.waitFor(() => expect(s.events.some((e) => e.type === "subagent.updated" && e.status !== "running")).toBe(true));
      const start = s.events.find((e) => e.type === "subagent.started");
      expect(start).toMatchObject({ type: "subagent.started", title: expect.any(String), toolCallId: expect.any(String), prompt: expect.any(String), agentType: "explore" });
      const childId = start!.subagentId;
      const child = s.events.filter((e) => e.subagentId === childId);
      expect(child.some((e) => e.type === "tool.started")).toBe(true);
      expect(s.events.every((e) => e.type !== "tool.started" || e.subagentId || e.name === "subagent")).toBe(true);
      expect(s.events.some((e) => e.type === "tool.completed" && typeof e.output === "object" && e.output !== null && "metadata" in e.output)).toBe(false);
      expect(s.events.filter((e) => e.type === "subagent.started")).toHaveLength(1);
      expect(s.calls[0]?.params).toMatchObject({ clientCapabilities: { _meta: { "opencode/child-session-updates": true } } });
      if (fixture === "C") expect(child.at(-1)).toMatchObject({ type: "subagent.updated", status: "stopped" });
      else expect(child.some((e) => e.type === "message.completed" && e.text.length > 0)).toBe(true);
      if (fixture === "D") expect(s.events.findIndex((e) => e.type === "turn.completed")).toBeLessThan(s.events.findIndex((e) => e.type === "subagent.updated" && e.status === "completed"));
    } finally {
      s.handle.close();
    }
  });

  it("keeps parallel and nested children separate and cancels only the selected child", async () => {
    const s = agent();
    try {
      await vi.waitFor(() => expect(s.promptCalls()).toHaveLength(1));
      const status = (id: string, parent: string, state: string) =>
        s.write({
          jsonrpc: "2.0",
          method: "opencode/session/child_update",
          params: { rootSessionId: "ses_1", childSessionId: id, parentSessionId: parent, depth: parent === "ses_1" ? 1 : 2, title: id, type: "status", status: state },
        });
      status("a", "ses_1", "created");
      status("b", "ses_1", "created");
      status("c", "a", "created");
      await vi.waitFor(() => expect(s.events.filter((e) => e.type === "subagent.started")).toHaveLength(3));
      expect(s.events.find((e) => e.type === "subagent.started" && e.subagentId === "c")).toMatchObject({ parentSubagentId: "a" });
      await s.handle.stopSubagent("a");
      await vi.waitFor(() => expect(s.notifications).toContainEqual({ method: "session/cancel", params: { sessionId: "a" } }));
      expect(s.events.some((e) => e.type === "turn.completed")).toBe(false);
      status("a", "ses_1", "interrupted");
      await vi.waitFor(() => expect(s.handle.canStopSubagent("a")).toBe(false));
      expect(s.handle.canStopSubagent("b")).toBe(true);
      s.finish();
    } finally {
      s.handle.close();
    }
  });
  it("refuses an unvetted checkout that carries OpenCode settings, which older releases load regardless", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "openorc-opencode-copy-"));
    try {
      writeFileSync(path.join(cwd, "opencode.json"), "{}");
      vi.mocked(spawn).mockClear();
      expect(() => agent("autonomous", { untrustedCheckout: true, cwd })).toThrow("OpenCode could load this pull request's own OpenCode settings and plugins, which can run commands.");
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("loads no opencode.json or .opencode plugins from an unvetted checkout", () => {
    for (const untrustedCheckout of [true, false]) {
      const s = agent("autonomous", { untrustedCheckout });
      try {
        expect(vi.mocked(spawn).mock.lastCall![2]!.env!["OPENCODE_DISABLE_PROJECT_CONFIG"]).toBe(untrustedCheckout ? "true" : process.env["OPENCODE_DISABLE_PROJECT_CONFIG"]);
      } finally {
        s.handle.close();
      }
    }
  });
  it.each(["review", "trusted"] as const)("rejects unsupported strict %s before spawning", (preset) => {
    vi.mocked(spawn).mockClear();
    expect(() => agent(preset)).toThrow("cannot currently guarantee approval");
    expect(spawn).not.toHaveBeenCalled();
  });
  it("selects the native Plan agent explicitly on resume and denies shell, edits and delegation", async () => {
    const s = agent("review", { mode: "plan", resumeSessionId: "old" });
    try {
      await vi.waitFor(() => expect(s.promptCalls()).toHaveLength(1));
      expect(s.calls).toContainEqual(expect.objectContaining({ method: "session/set_config_option", params: { sessionId: "old", configId: "mode", value: "plan" } }));
      const config = JSON.parse(vi.mocked(spawn).mock.lastCall![2]!.env!["OPENCODE_CONFIG_CONTENT"]!);
      expect(config.agents.plan.permissions[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
      expect(config.agents.plan.permissions.some((p: { action: string }) => ["shell", "edit", "subagent"].includes(p.action))).toBe(false);
    } finally {
      s.handle.close();
    }
  });
  it("preserves inline JSONC settings while suppressing native questions only in the child process", async () => {
    const original = process.env["OPENCODE_CONFIG_CONTENT"];
    process.env["OPENCODE_CONFIG_CONTENT"] =
      '{ // inherited settings\n "permissions": [{"action":"shell","resource":"*","effect":"ask"}], "agents":{"custom":{"description":"Keep me","permissions":[{"action":"question","resource":"*","effect":"allow"}]}}, "model":"existing/model", }';
    try {
      const s = agent();
      await vi.waitFor(() => expect(s.promptCalls()).toHaveLength(1));
      const config = JSON.parse(vi.mocked(spawn).mock.lastCall![2]!.env!["OPENCODE_CONFIG_CONTENT"]!);
      expect(config.model).toBe("existing/model");
      expect(config.permissions).toEqual([
        { action: "shell", resource: "*", effect: "ask" },
        { action: "question", resource: "*", effect: "deny" },
      ]);
      expect(config.agents.custom.description).toBe("Keep me");
      expect(config.agents.custom.permissions.at(-1)).toEqual({ action: "question", resource: "*", effect: "deny" });
      expect(process.env["OPENCODE_CONFIG_CONTENT"]).toContain("// inherited settings");
      s.finish();
      await vi.waitFor(() => expect(eventTypes(s.events)).toContain("turn.completed"));
      await s.handle.send("Follow-up");
      await vi.waitFor(() => expect(s.promptCalls()).toHaveLength(2));
      expect(JSON.stringify(s.promptCalls()[1]!.params)).toContain("openorc_0123456789abcdef0123456789abcdef_ask_user");
      s.handle.close();
    } finally {
      if (original === undefined) delete process.env["OPENCODE_CONFIG_CONTENT"];
      else process.env["OPENCODE_CONFIG_CONTENT"] = original;
    }
  });

  it("leaves native configuration alone when no ask_user tool is attached", async () => {
    const s = agent("autonomous", { internalMcp: undefined, mcpUrl: undefined });
    await vi.waitFor(() => expect(s.promptCalls()).toHaveLength(1));
    expect(vi.mocked(spawn).mock.lastCall![2]!.env!["OPENCODE_CONFIG_CONTENT"]).toBe(process.env["OPENCODE_CONFIG_CONTENT"]);
    expect(JSON.stringify(s.promptCalls()[0]!.params)).not.toContain("ask_user");
    s.handle.close();
  });

  it("streams updates through the mapper and completes the turn with the agent's stop reason and usage", async () => {
    const s = agent();
    await vi.waitFor(() => expect(s.promptCalls()).toHaveLength(1));
    s.update("ses_1", { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Done." } });
    s.update("ses_1", { sessionUpdate: "usage_update", used: 900, size: 128_000, cost: { amount: 0.002, currency: "USD" } });
    // Another session's updates are not this transcript's.
    s.update("ses_other", { sessionUpdate: "agent_message_chunk", messageId: "x", content: { type: "text", text: "Nope" } });
    await vi.waitFor(() => expect(s.events.some((event) => event.type === "message.delta")).toBe(true));
    s.finish({ stopReason: "end_turn", usage: { totalTokens: 30, inputTokens: 20, outputTokens: 10, cachedReadTokens: 5 } });
    await vi.waitFor(() => expect(eventTypes(s.events)).toContain("turn.completed"));
    expect(s.events.filter((event) => event.type === "message.delta").map((event) => (event as { text: string }).text)).toEqual(["Done."]);
    expect(s.events.find((event) => event.type === "turn.completed")).toMatchObject({
      status: "success",
      resultText: "Done.",
      usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 5, costUsd: 0.002, contextTokens: 900, contextWindow: 128_000 },
    });
    // A follow-up prompts the same session.
    await s.handle.send("Again");
    await vi.waitFor(() => expect(s.promptCalls()).toHaveLength(2));
    expect(s.promptCalls()[1]!.params).toMatchObject({ sessionId: "ses_1" });
    s.handle.close();
  });

  it("changes the model and effort of the open session between turns and refuses during one", async () => {
    const s = agent("autonomous", { model: "openrouter/acme/fast" });
    await vi.waitFor(() => expect(s.promptCalls()).toHaveLength(1));
    expect(s.handle.canApplySettings).toBe(true);
    await expect(s.handle.applySettings({ model: "opencode/big" })).rejects.toThrow("Wait for the current turn to finish");
    s.finish();
    await vi.waitFor(() => expect(eventTypes(s.events)).toContain("turn.completed"));
    await s.handle.applySettings({ model: "opencode/big", effort: "high" });
    const options = s.calls.filter((call) => call.method === "session/set_config_option").map((call) => call.params);
    expect(options).toEqual([
      { sessionId: "ses_1", configId: "model", value: "openrouter/acme/fast" },
      { sessionId: "ses_1", configId: "model", value: "opencode/big" },
      { sessionId: "ses_1", configId: "effort", value: "high" },
    ]);
    expect(s.calls.filter((call) => call.method === "session/new")).toHaveLength(1);
    await expect(s.handle.applySettings({ fastMode: true })).rejects.toThrow("does not expose a separate Fast mode control");
    await s.handle.send("Again");
    await vi.waitFor(() => expect(s.promptCalls()).toHaveLength(2));
    s.handle.close();
  });

  it("answers a permission request with the option matching the app's decision", async () => {
    const decide = vi.fn(async (): Promise<ApprovalDecision> => "allow_for_run");
    const s = agent("autonomous", {}, decide);
    await vi.waitFor(() => expect(s.promptCalls()).toHaveLength(1));
    const answer = s.askPermission({ toolCallId: "c1", title: "rm -rf build", kind: "execute", status: "pending", rawInput: { command: "rm -rf build" } });
    await expect(answer).resolves.toEqual({ outcome: { outcome: "selected", optionId: "always" } });
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", kind: "command", toolName: "shell", detail: "rm -rf build", input: { command: "rm -rf build" }, onceOnly: false }));
    expect(s.events.find((event) => event.type === "approval.resolved")).toMatchObject({ decision: "allow_for_run" });
    s.handle.close();
  });

  it("marks a request the agent cannot keep allowing as once only", async () => {
    const decide = vi.fn(async (): Promise<ApprovalDecision> => "allow");
    const s = agent("autonomous", {}, decide);
    await vi.waitFor(() => expect(s.promptCalls()).toHaveLength(1));
    const answer = s.askPermission({ toolCallId: "c1", title: "rm -rf build", kind: "execute", status: "pending" }, [
      { optionId: "once", kind: "allow_once", name: "Allow once" },
      { optionId: "reject", kind: "reject_once", name: "Reject" },
    ]);
    await expect(answer).resolves.toEqual({ outcome: { outcome: "selected", optionId: "once" } });
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ onceOnly: true }));
    s.handle.close();
  });

  it("cancels the turn and any open permission request on interrupt", async () => {
    let decide!: (decision: ApprovalDecision) => void;
    const s = agent("autonomous", {}, () => new Promise<ApprovalDecision>((resolve) => (decide = resolve)));
    await vi.waitFor(() => expect(s.promptCalls()).toHaveLength(1));
    const answer = s.askPermission({ toolCallId: "c1", title: "write", kind: "edit", status: "pending" });
    await vi.waitFor(() => expect(decide).toBeDefined());
    await s.handle.interrupt();
    await expect(answer).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    await vi.waitFor(() => expect(s.notifications.map((n) => n.method)).toContain("session/cancel"));
    await vi.waitFor(() => expect(s.events.find((event) => event.type === "turn.completed")).toMatchObject({ status: "cancelled" }));
    s.handle.close();
  });

  it("resumes an existing session without creating one and reports the process exit once", async () => {
    const s = agent("autonomous", { resumeSessionId: "ses_old" });
    await vi.waitFor(() => expect(s.promptCalls()).toHaveLength(1));
    expect(s.calls.map((call) => call.method)).toEqual(["initialize", "session/resume", "session/prompt"]);
    expect(s.calls[1]!.params).toMatchObject({ sessionId: "ses_old", cwd: "/repo" });
    expect(s.events.find((event) => event.type === "session.started")).toMatchObject({ externalSessionId: "ses_old" });
    s.handle.close();
    await s.handle.wait();
    expect(s.events.filter((event) => event.type === "session.completed")).toHaveLength(1);
    expect(s.events.find((event) => event.type === "turn.completed")).toMatchObject({ status: "error" });
  });
});

describe("AcpAdapter on a host", () => {
  /** A cloud sandbox as the adapter sees it: its own process, address for OpenOrc's tools, and copies of files. */
  function host() {
    return {
      home: "/home/sandbox",
      privateDir: () => "/home/sandbox/private",
      localUrl: (url: string) => url.replace("127.0.0.1:1", "127.0.0.1:41000"),
      // The scripted agent's pipes, as the host's process would carry them.
      spawn: vi.fn(() => vi.mocked(spawn)("opencode")),
      upload: vi.fn(async (paths: string[]) => paths.map((file) => `/home/sandbox/uploads/${path.basename(file)}`)),
    };
  }

  it("starts OpenCode on the host, reaching OpenOrc's tools at the host's address and naming files by the host's copies", async () => {
    const sandbox = host();
    vi.mocked(spawn).mockClear();
    const s = agent("autonomous", { attachments: ["/Users/me/notes.md"] }, undefined, {
      revision: 0,
      binary: "opencode",
      env: { PATH: "/usr/bin", OPENCODE_CONFIG_CONTENT: '{"provider":{"openrouter":{"options":{"apiKey":"k"}}}}' },
      host: sandbox as never,
    });
    await vi.waitFor(() => expect(s.promptCalls()).toHaveLength(1));
    expect(sandbox.spawn).toHaveBeenCalledWith("opencode", ["acp"], expect.objectContaining({ runId: "run-1", cwd: "/repo" }));
    const env = (sandbox.spawn.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }])[2].env;
    expect(JSON.parse(env["OPENCODE_CONFIG_CONTENT"]!).provider.openrouter.options.apiKey).toBe("k");
    expect(s.calls.find((call) => call.method === "session/new")!.params["mcpServers"]).toEqual([expect.objectContaining({ url: "http://127.0.0.1:41000/mcp" })]);
    expect(JSON.stringify(s.promptCalls()[0]!.params["prompt"])).toContain("/home/sandbox/uploads/notes.md");
  });

  it("refuses an unvetted checkout on a host, whose settings it cannot look into", () => {
    expect(() =>
      new AcpAdapter({ onApproval: async () => "allow" }).start(
        { runId: "r", agent: "opencode", cwd: "/repo", prompt: "x", permissionMode: "autonomous", untrustedCheckout: true },
        { ...launch, host: host() as never },
      ),
    ).toThrow("OpenCode could load this pull request's own OpenCode settings");
  });
});

describe("AcpAdapter errors", () => {
  it("preserves an unavailable-model error without inventing an authentication diagnosis", async () => {
    const s = agent("autonomous", { model: "opencode/glm-5.3-flash" });
    await vi.waitFor(() => expect(s.promptCalls()).toHaveLength(1));
    s.fail("Internal error: Model unavailable: opencode/glm-5.3-flash");
    await vi.waitFor(() => expect(eventTypes(s.events)).toContain("turn.completed"));
    expect(s.events.find((event) => event.type === "activity.updated")).toMatchObject({
      label: "Provider error",
      status: "error",
      text: "OpenCode reports opencode/glm-5.3-flash is unavailable. Check the model ID, provider configuration and account access, or choose another model. Provider detail: Internal error: Model unavailable: opencode/glm-5.3-flash",
    });
    expect(s.events.find((event) => event.type === "turn.completed")).toMatchObject({ status: "error" });
    s.handle.close();
  });
});

describe("modelsFrom", () => {
  it("reads flat and grouped model options with their provider", () => {
    const flat = modelsFrom([{ id: "model", name: "Model", type: "select", currentValue: "openrouter/acme/fast", options: [{ value: "openrouter/acme/fast", name: "OpenRouter/Acme Fast" }] }]);
    expect(flat).toEqual([{ id: "openrouter/acme/fast", label: "Acme Fast", provider: { id: "openrouter", label: "OpenRouter" }, isDefault: true }]);
    const grouped = modelsFrom([
      { id: "model", name: "Model", type: "select", currentValue: "opencode/big", options: [{ group: "opencode", name: "opencode", options: [{ value: "opencode/big", name: "opencode/Big" }] }] },
    ]);
    expect(grouped).toEqual([{ id: "opencode/big", label: "Big", provider: { id: "opencode", label: "opencode" }, isDefault: true }]);
    expect(modelsFrom([{ id: "mode", name: "Mode", type: "select", currentValue: "build", options: [] }])).toEqual([]);
  });
});

it.each([true, false])("denies a dropped child's permission whether it arrives before the drop: %s", async (early) => {
  const requests: AcpApprovalRequest[] = [];
  const s = agent("autonomous", {}, async (request) => {
    requests.push(request);
    return new Promise(() => {});
  });
  try {
    await vi.waitFor(() => expect(s.promptCalls()).toHaveLength(1));
    const permission = () => s.askPermission({ toolCallId: "read", title: "Read file", kind: "read" }, undefined, "orphan");
    const pending = early ? permission() : null;
    if (early) await vi.waitFor(() => expect(requests).toHaveLength(1));
    s.write({
      jsonrpc: "2.0",
      method: "opencode/session/child_update",
      params: { rootSessionId: "ses_1", childSessionId: "orphan", parentSessionId: "missing", title: "Orphan", type: "status", status: "created" },
    });
    await expect(pending ?? permission()).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    expect(requests).toHaveLength(early ? 1 : 0);
  } finally {
    s.handle.close();
  }
});
