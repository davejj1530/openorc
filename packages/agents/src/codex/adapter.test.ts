import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { CodexAdapter, type CodexAdapterOptions } from "./adapter.js";
import type { AgentEvent, PermissionPreset, RunSpec } from "@openorc/protocol";

const launch = { revision: 0, binary: "codex", env: process.env };

it("preserves the advertised efforts and default for Astra and other models", async () => {
  const stdin = new PassThrough(),
    stdout = new PassThrough(),
    stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    kill: () => {
      proc.emit("exit", 0);
      proc.emit("close", 0);
      return true;
    },
  });
  vi.mocked(spawn).mockReturnValue(proc as unknown as ChildProcess);
  stdin.on("data", (data: Buffer) => {
    const request = JSON.parse(data.toString());
    if (request.id === undefined) return;
    const result =
      request.method === "model/list"
        ? {
            data: ["gpt-6-astra", "gpt-5.6-sol"].map((model) => ({
              id: model,
              model,
              displayName: model,
              isDefault: false,
              hidden: false,
              supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map((reasoningEffort) => ({ reasoningEffort })),
              defaultReasoningEffort: "max",
            })),
          }
        : {};
    queueMicrotask(() => stdout.write(JSON.stringify({ id: request.id, result }) + "\n"));
  });
  const models = await new CodexAdapter({ onApproval: async () => "deny" }).listModels();
  expect(models[0]).toMatchObject({ efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "max" });
  expect(models[1]).toMatchObject({ efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "max" });
});

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

/** The layers the scripted app-server reports for a folder's settings. */
let configLayers: { name: { type: string }; disabledReason?: string }[] | undefined;

/** Scripted app-server transport; the adapter and JSON-RPC client run unchanged. */
function server(permissionMode: PermissionPreset = "autonomous", overrides: Partial<RunSpec> = {}, onApproval: CodexAdapterOptions["onApproval"] = async () => "deny", requirePaginatedResume = false) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: undefined,
    kill: () => {
      proc.emit("exit", 0);
      proc.emit("close", 0);
      return true;
    },
  });
  vi.mocked(spawn).mockReturnValue(proc as unknown as ChildProcess);
  const calls: { id: number; method: string; params: Record<string, unknown> }[] = [];
  const responses: { id: number; result?: unknown; error?: { code: number; message: string } }[] = [];
  const notify = (method: string, params: unknown) => stdout.write(JSON.stringify({ method, params }) + "\n");
  const request = (id: number, method: string, params: unknown) => stdout.write(JSON.stringify({ id, method, params }) + "\n");
  let compacting = false;
  let turn = 0;
  const steering = { hold: false, error: null as string | null, replies: [] as (() => void)[] };
  const interruption = { hold: false, error: null as string | null, replies: [] as (() => void)[] };
  stdin.on("data", (data: Buffer) => {
    const req = JSON.parse(data.toString());
    if (!req.id) return;
    if (!req.method) {
      responses.push(req);
      return;
    }
    calls.push(req);
    queueMicrotask(() => {
      if (requirePaginatedResume && ["thread/resume", "thread/fork"].includes(req.method) && req.params.excludeTurns !== true) {
        stdout.write(
          JSON.stringify({
            id: req.id,
            error: { code: -32600, message: "Full-history hydration is deprecated for paginated threads; use `excludeTurns: true`, then page with `thread/turns/list` and `thread/items/list`." },
          }) + "\n",
        );
        return;
      }
      let result: object = {};
      if (req.method === "config/read") result = { config: { mcp_servers: { external: {} } }, ...(configLayers ? { layers: configLayers } : {}) };
      else if (["thread/start", "thread/resume", "thread/fork"].includes(req.method)) result = { thread: { id: "thread-1" } };
      if (req.method === "turn/steer" && compacting) {
        stdout.write(JSON.stringify({ id: req.id, error: { code: -32600, message: "cannot steer a compact turn" } }) + "\n");
        return;
      }
      if (req.method === "thread/compact/start") {
        compacting = true;
        notify("turn/started", { threadId: "thread-1", turn: { id: "compact-1" } });
        notify("item/started", { threadId: "thread-1", turnId: "compact-1", item: { id: "compact-item", type: "contextCompaction" } });
      }
      if (req.method === "turn/start") notify("turn/started", { threadId: "thread-1", turn: { id: `work-${++turn}` } });
      if (req.method === "turn/interrupt") {
        const reply = () => {
          const error = typeof req.params.turnId !== "string" ? "Invalid request: missing field `turnId`" : interruption.error;
          stdout.write(JSON.stringify(error ? { id: req.id, error: { code: -32600, message: error } } : { id: req.id, result: {} }) + "\n");
          if (!error) notify("turn/completed", { threadId: "thread-1", turn: { id: req.params.turnId, status: "interrupted" } });
        };
        if (interruption.hold) interruption.replies.push(reply);
        else reply();
        return;
      }
      if (req.method === "turn/steer") {
        const reply = () =>
          stdout.write(JSON.stringify(steering.error ? { id: req.id, error: { code: -32600, message: steering.error } } : { id: req.id, result: { turnId: req.params.expectedTurnId } }) + "\n");
        if (steering.hold) steering.replies.push(reply);
        else reply();
        return;
      }
      stdout.write(JSON.stringify({ id: req.id, result }) + "\n");
    });
  });
  const finish = (id: string) => {
    if (id === "compact-1") {
      compacting = false;
      notify("item/completed", { threadId: "thread-1", turnId: id, item: { id: "compact-item", type: "contextCompaction" } });
    }
    notify("turn/completed", { threadId: "thread-1", turn: { id, status: "completed" } });
  };
  const handle = new CodexAdapter({ onApproval }).start({ runId: "run-1", agent: "codex", cwd: process.cwd(), prompt: "Hello", permissionMode, ...overrides }, launch);
  return { calls, responses, handle, finish, notify, request, proc, steering, interruption };
}

it.each([false, true])("continues a paginated Codex thread without full-history hydration (fork=%s)", async (forkSession) => {
  const s = server("autonomous", { resumeSessionId: "existing", forkSession }, async () => "deny", true);
  const errors: string[] = [];
  s.handle.on("event", (event: AgentEvent) => {
    if (event.type === "error") errors.push(event.message);
  });
  try {
    await vi.waitFor(() => expect(errors.length || s.calls.some((call) => call.method === "turn/start")).toBeTruthy());
    expect(errors).toEqual([]);
    expect(s.calls.some((call) => call.method === "turn/start")).toBe(true);
  } finally {
    s.handle.close();
    await s.handle.wait();
  }
});

it("rejects a malformed elicitation form without approval and answers the next valid request", async () => {
  const approvals: unknown[] = [];
  const s = server("autonomous", {}, async (request) => {
    approvals.push(request);
    return "allow";
  });
  try {
    await vi.waitFor(() => expect(s.calls.some((call) => call.method === "turn/start")).toBe(true));
    s.request(901, "mcpServer/elicitation/request", { mode: "form", requestedSchema: { properties: { choice: null } } });
    await vi.waitFor(() => expect(s.responses.find((response) => response.id === 901)).toMatchObject({ error: { code: -32602 } }));
    expect(approvals).toHaveLength(0);

    s.request(902, "mcpServer/elicitation/request", { mode: "form", requestedSchema: { properties: { choice: { enum: ["first", "second"] } } } });
    await vi.waitFor(() => expect(s.responses.find((response) => response.id === 902)).toMatchObject({ result: { action: "accept", content: { choice: "first" } } }));
    expect(approvals).toEqual([expect.objectContaining({ kind: "tool", onceOnly: true })]);
  } finally {
    s.handle.close();
    await s.handle.wait();
  }
});

describe("Codex in an unvetted checkout", () => {
  const run = async (layers: typeof configLayers) => {
    configLayers = layers;
    const s = server("autonomous", { untrustedCheckout: true });
    const errors: string[] = [];
    s.handle.on("event", (event: AgentEvent) => {
      if (event.type === "error") errors.push(event.message);
    });
    try {
      await vi.waitFor(() => expect(errors.length || s.calls.some((call) => call.method === "turn/start")).toBeTruthy());
      return { errors, methods: s.calls.map((call) => call.method), read: s.calls.find((call) => call.method === "config/read")?.params };
    } finally {
      configLayers = undefined;
      s.handle.close();
      await s.handle.wait();
    }
  };

  it("refuses to start when Codex would apply the checkout's own .codex settings", async () => {
    const { errors, methods, read } = await run([{ name: { type: "project" } }, { name: { type: "user" } }]);
    expect(read).toMatchObject({ includeLayers: true });
    expect(errors).toEqual(["Codex trusts this repository, so it would load the pull request's own .codex settings, which can run commands. Review it with a Claude model instead."]);
    expect(methods).not.toContain("thread/start");
  });

  it("refuses when Codex doesn't say which settings it would apply", async () => {
    const { errors, methods } = await run(undefined);
    expect(errors).toEqual([
      "This version of Codex can't show whether it would load the pull request's own .codex settings, which can run commands. Update Codex, or review it with a Claude model instead.",
    ]);
    expect(methods).not.toContain("thread/start");
  });

  it("starts when Codex ignores them because the folder isn't trusted", async () => {
    const { errors, methods } = await run([{ name: { type: "project" }, disabledReason: "Add it as a trusted project to load project-local config." }]);
    expect(errors).toEqual([]);
    expect(methods).toContain("turn/start");
  });
});

describe("Codex Stop", () => {
  it.each([true])("interrupts the owning work turn, including after automatic compaction (compacted=%s)", async (compacted) => {
    const s = server();
    const events: AgentEvent[] = [];
    s.handle.on("event", (event) => events.push(event));
    try {
      await vi.waitFor(() => expect(s.handle.canSteer).toBe(true));
      if (compacted) {
        s.notify("item/started", { threadId: "thread-1", turnId: "work-1", item: { id: "auto", type: "contextCompaction" } });
        s.notify("item/completed", { threadId: "thread-1", turnId: "work-1", item: { id: "auto", type: "contextCompaction" } });
      }
      s.notify("turn/started", { threadId: "child-thread", turn: { id: "child-turn" } });
      await s.handle.interrupt();
      await new Promise(setImmediate);
      expect(s.calls.find((c) => c.method === "turn/interrupt")?.params).toEqual({ threadId: "thread-1", turnId: "work-1" });
      expect(events).toContainEqual(expect.objectContaining({ type: "turn.completed", turnId: "work-1", status: "cancelled" }));
      expect(s.handle.canSteer).toBe(false);
    } finally {
      s.handle.close();
    }
  });

  it("awaits the interrupt acknowledgement and sends nothing when already idle", async () => {
    const s = server();
    try {
      await vi.waitFor(() => expect(s.handle.canSteer).toBe(true));
      s.interruption.hold = true;
      const accepted = vi.fn();
      const stop = Promise.resolve(s.handle.interrupt()).then(accepted);
      await new Promise(setImmediate);
      expect(accepted).not.toHaveBeenCalled();
      s.interruption.replies[0]!();
      await stop;
      await s.handle.interrupt();
      expect(s.calls.filter((c) => c.method === "turn/interrupt")).toHaveLength(1);
    } finally {
      s.handle.close();
    }
  });

  it("interrupts a manual compaction turn and rejects its waiting message", async () => {
    const s = server();
    try {
      await vi.waitFor(() => expect(s.handle.canSteer).toBe(true));
      s.finish("work-1");
      const compact = s.handle.compact().catch((error) => error);
      await vi.waitFor(() => expect(s.calls.some((c) => c.method === "thread/compact/start")).toBe(true));
      const send = s.handle.send("Do not start this after stopping").catch((error) => error);
      await s.handle.interrupt();
      expect(s.calls.find((c) => c.method === "turn/interrupt")?.params).toEqual({ threadId: "thread-1", turnId: "compact-1" });
      expect(await compact).toBeInstanceOf(Error);
      expect(await send).toBeInstanceOf(Error);
      expect(s.calls.filter((c) => c.method === "turn/start")).toHaveLength(1);
    } finally {
      s.handle.close();
    }
  });
});

describe("Codex notification ownership", () => {
  it.each([{ resumeSessionId: "existing", forkSession: true }])("keeps the parent turn active through child output and completion (%j)", async (overrides) => {
    const s = server("autonomous", overrides);
    const events: AgentEvent[] = [];
    s.handle.on("event", (event) => events.push(event));
    try {
      await vi.waitFor(() => expect(s.handle.canSteer).toBe(true));
      s.notify("item/completed", { threadId: "thread-1", turnId: "work-1", item: { id: "progress", type: "agentMessage", text: "I will continue checking." } });
      s.notify("turn/started", { threadId: "child-thread", turn: { id: "child-turn" } });
      await s.handle.steer("Keep checking");
      expect(s.calls.at(-1)).toMatchObject({ method: "turn/steer", params: { threadId: "thread-1", expectedTurnId: "work-1" } });

      const childEvents = [
        { method: "item/agentMessage/delta", params: { threadId: "child-thread", turnId: "child-turn", itemId: "child-reply", delta: "Child done" } },
        { method: "item/completed", params: { threadId: "child-thread", turnId: "child-turn", item: { id: "child-reply", type: "agentMessage", text: "Child done" } } },
        { method: "turn/completed", params: { threadId: "child-thread", turn: { id: "child-turn", status: "completed" } } },
      ];
      for (const event of childEvents) s.notify(event.method, event.params);
      expect(s.handle.canSteer).toBe(true);
      expect(events.filter((event) => event.type === "turn.completed")).toEqual([]);
      expect(events.filter((event) => event.type === "turn.started")).toEqual([expect.objectContaining({ turnId: "work-1" })]);
      expect(events.filter((event) => event.type === "message.completed")).toEqual([expect.objectContaining({ messageId: "progress", text: "I will continue checking." })]);
      for (const event of childEvents) expect(events).toContainEqual(expect.objectContaining({ type: "raw", payload: event }));

      s.notify("item/completed", { threadId: "thread-1", turnId: "work-1", item: { id: "child-activity", type: "subAgentActivity", agentPath: "/root/checker", kind: "completed" } });
      expect(events).toContainEqual(expect.objectContaining({ type: "activity.updated", activityId: "child-activity" }));
      s.notify("item/completed", { threadId: "thread-1", turnId: "work-1", item: { id: "final", type: "agentMessage", text: "Parent done" } });
      s.finish("work-1");
      expect(s.handle.canSteer).toBe(false);
      expect(events.filter((event) => event.type === "turn.completed")).toEqual([expect.objectContaining({ turnId: "work-1", status: "success" })]);
      s.handle.close();
      await s.handle.wait();
      expect(events).toContainEqual(expect.objectContaining({ type: "session.completed", turns: 1 }));
    } finally {
      s.handle.close();
      await s.handle.wait();
    }
  });

  it("keeps child maintenance, usage and errors out of the parent's state", async () => {
    const s = server();
    const events: AgentEvent[] = [];
    s.handle.on("event", (event) => events.push(event));
    try {
      await vi.waitFor(() => expect(s.handle.canSteer).toBe(true));
      events.length = 0;
      s.notify("item/started", { threadId: "child-thread", turnId: "child-turn", item: { id: "child-compact", type: "contextCompaction" } });
      expect(s.handle.compacting).toBe(false);
      expect(s.handle.canSteer).toBe(true);
      s.notify("thread/tokenUsage/updated", { threadId: "child-thread", tokenUsage: { total: { inputTokens: 999, outputTokens: 123 } } });
      s.notify("error", { threadId: "child-thread", willRetry: false, error: { message: "Child failed" } });
      s.notify("thread/closed", { threadId: "child-thread" });
      expect(events.filter((event) => event.type !== "raw")).toEqual([]);

      s.notify("item/started", { threadId: "thread-1", turnId: "work-1", item: { id: "parent-compact", type: "contextCompaction" } });
      s.notify("item/completed", { threadId: "child-thread", turnId: "child-turn", item: { id: "child-compact", type: "contextCompaction" } });
      s.notify("thread/compacted", { threadId: "child-thread", turnId: "child-turn" });
      s.notify("error", { threadId: "child-thread", willRetry: false, error: { message: "Child compaction failed" } });
      expect(events.filter((event) => event.type === "activity.updated")).toEqual([expect.objectContaining({ activityId: "parent-compact", status: "running" })]);
      s.finish("work-1");
      expect(s.handle.compacting).toBe(false);
      expect(events).toContainEqual(expect.objectContaining({ type: "activity.updated", activityId: "parent-compact", status: "success" }));

      s.notify("warning", { message: "Server notice" });
      expect(events).toContainEqual(expect.objectContaining({ type: "activity.updated", text: "Server notice" }));
    } finally {
      s.handle.close();
      await s.handle.wait();
    }
  });
});

describe("Codex exact-turn steering", () => {
  it("carries a model and effort change on the next turn instead of a new process", async () => {
    const s = server("autonomous", { model: "gpt-5.6-sol", effort: "medium" });
    try {
      await vi.waitFor(() => expect(s.handle.canSteer).toBe(true));
      expect(s.handle.canApplySettings).toBe(true);
      await expect(s.handle.applySettings({ model: "gpt-6-astra" })).rejects.toThrow("Wait for the current turn to finish");
      s.finish("work-1");
      await vi.waitFor(() => expect(s.handle.canSteer).toBe(false));
      await s.handle.applySettings({ model: "gpt-6-astra", effort: "high", fastMode: true });
      await s.handle.send("Next");
      s.finish("work-2");
      await vi.waitFor(() => expect(s.handle.canSteer).toBe(false));
      await s.handle.applySettings({ fastMode: false });
      await s.handle.send("Standard again");
      const starts = s.calls.filter((c) => c.method === "turn/start");
      expect(starts).toHaveLength(3);
      expect(starts[0]!.params).not.toHaveProperty("model");
      expect(starts[0]!.params).toMatchObject({ serviceTier: "default" });
      expect(starts[1]!.params).toMatchObject({ model: "gpt-6-astra", effort: "high", serviceTier: "priority" });
      expect(starts[2]!.params).toMatchObject({ model: "gpt-6-astra", effort: "high", serviceTier: "default" });
      expect(s.calls.filter((c) => ["thread/start", "thread/resume"].includes(c.method))).toHaveLength(1);
    } finally {
      s.handle.close();
    }
  });

  it("retains the exact turn when its completion arrives before acknowledgment", async () => {
    const s = server();
    try {
      await vi.waitFor(() => expect(s.handle.canSteer).toBe(true));
      s.steering.hold = true;
      const delivery = s.handle.steer("Late correction");
      await vi.waitFor(() => expect(s.steering.replies).toHaveLength(1));
      s.finish("work-1");
      s.steering.replies[0]!();
      await expect(delivery).resolves.toBe("accepted");
      expect(s.handle.canSteer).toBe(false);
      expect(s.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
    } finally {
      s.handle.close();
    }
  });

  it("keeps transport rejection or disconnect distinct from a proven unsent request", async () => {
    const s = server();
    try {
      await vi.waitFor(() => expect(s.handle.canSteer).toBe(true));
      s.steering.error = "expected turn is no longer active";
      await expect(s.handle.steer("Rejected correction")).rejects.toThrow("expected turn");
      s.steering.hold = true;
      const pending = s.handle.steer("Unconfirmed correction");
      const rejected = expect(pending).rejects.toThrow("before responding");
      await vi.waitFor(() => expect(s.steering.replies).toHaveLength(1));
      s.handle.close();
      await rejected;
      expect(s.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
    } finally {
      s.handle.close();
    }
  });
});

describe("Codex permission presets", () => {
  it.skipIf(process.platform === "win32")("contains exit cleanup denial while retaining the descendant barrier", async () => {
    const s = server();
    await vi.waitFor(() => expect(s.calls.some((call) => call.method === "turn/start")).toBe(true));
    Object.defineProperty(s.proc, "pid", { value: 987652 });
    let exists = true;
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (!exists) throw Object.assign(new Error("Gone"), { code: "ESRCH" });
      if (signal !== 0) throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      return true;
    });
    const events: unknown[] = [];
    s.handle.on("event", (event) => events.push(event));
    try {
      expect(() => s.proc.emit("exit", 0)).not.toThrow();
      s.proc.emit("close", 0);
      let finished = false;
      const done = s.handle.wait().then(() => {
        finished = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(finished).toBe(false);
      expect(events).toContainEqual(expect.objectContaining({ type: "error", fatal: false, message: expect.stringContaining("cleanup needs attention") }));
      exists = false;
      await done;
      expect(finished).toBe(true);
    } finally {
      exists = false;
      kill.mockRestore();
    }
  });

  it("scopes pre-approval to the app-created connection and keeps its secret address out of argv", async () => {
    const internalMcp = { serverName: "openorc_0123456789abcdef0123456789abcdef", url: "http://127.0.0.1:1234/mcp/token", toolNames: ["task_list", "task_create"] };
    const s = server("autonomous", { internalMcp });
    try {
      const args = vi.mocked(spawn).mock.lastCall![1] as string[];
      expect(args.some((arg) => arg.includes("/mcp/token") || arg.includes("mcp_servers"))).toBe(false);
      await vi.waitFor(() =>
        expect(s.calls.find((c) => c.method === "thread/start")?.params).toMatchObject({
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          config: {
            [`mcp_servers.${internalMcp.serverName}.url`]: internalMcp.url,
            ...Object.fromEntries(internalMcp.toolNames.map((name) => [`mcp_servers.${internalMcp.serverName}.tools.${name}.approval_mode`, "approve"])),
          },
        }),
      );
    } finally {
      s.handle.close();
    }
    const legacy = server("autonomous", { mcpUrl: internalMcp.url });
    try {
      await vi.waitFor(() => expect(legacy.calls.find((c) => c.method === "thread/start")?.params).toMatchObject({ config: { [`mcp_servers.openorc.url`]: internalMcp.url } }));
      expect(Object.keys((legacy.calls.find((c) => c.method === "thread/start")?.params as { config: object }).config).some((key) => key.endsWith("approval_mode"))).toBe(false);
    } finally {
      legacy.handle.close();
    }
  });
  it.each(["review", "trusted"] as const)("starts %s with manual native approvals for new, resumed, and forked threads", async (preset) => {
    for (const overrides of [{}, { resumeSessionId: "old" }, { resumeSessionId: "old", forkSession: true }]) {
      const s = server(preset, overrides);
      try {
        await vi.waitFor(() => expect(s.calls.some((c) => c.method === "turn/start")).toBe(true));
        let method = "thread/start";
        if (overrides.resumeSessionId) method = overrides.forkSession ? "thread/fork" : "thread/resume";
        expect(s.calls.find((c) => c.method === method)?.params).toMatchObject({
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: preset === "review" ? "read-only" : "workspace-write",
          config: { "sandbox_workspace_write.network_access": false },
        });
      } finally {
        s.handle.close();
      }
    }
  });
  it("starts native Plan with a readonly sandbox, no escalation, and external MCP disabled", async () => {
    const s = server("review", { mode: "plan", model: "fixture", resumeSessionId: "old", effort: "high" });
    try {
      await vi.waitFor(() => expect(s.calls.some((c) => c.method === "turn/start")).toBe(true));
      expect(s.calls.find((c) => c.method === "thread/resume")?.params).toMatchObject({ sandbox: "read-only", approvalPolicy: "never", config: { "mcp_servers.external.enabled": false } });
      expect(s.calls.find((c) => c.method === "turn/start")?.params).toMatchObject({
        sandboxPolicy: { type: "readOnly" },
        collaborationMode: { mode: "plan", settings: { model: "fixture", reasoning_effort: "high" } },
      });
    } finally {
      s.handle.close();
    }
  });
  it.each([["autonomous", "never", "danger-full-access"]] as const)("maps %s to the matching provider approval policy", async (preset, approvalPolicy, sandbox) => {
    const s = server(preset);
    try {
      await vi.waitFor(() => expect(s.calls.some((c) => c.method === "thread/start")).toBe(true));
      expect(s.calls.find((c) => c.method === "thread/start")?.params).toMatchObject({ approvalPolicy, sandbox });
    } finally {
      s.handle.close();
    }
  });
});

describe("Codex compaction lifecycle", () => {
  it("coalesces repeated compaction calls, waits for completion rather than RPC acceptance, and does not publish maintenance as an agent reply", async () => {
    const s = server();
    try {
      await vi.waitFor(() => expect(s.calls.some((c) => c.method === "turn/start")).toBe(true));
      s.finish("work-1");
      const events = vi.fn();
      s.handle.on("event", events);
      let completed = false;
      const first = s.handle.compact().then(() => {
        completed = true;
      });
      const second = s.handle.compact();
      await vi.waitFor(() => expect(s.calls.filter((c) => c.method === "thread/compact/start")).toHaveLength(1));
      await new Promise(setImmediate);
      expect(completed).toBe(false);
      s.finish("compact-1");
      await Promise.all([first, second]);
      expect(completed).toBe(true);
      expect(events.mock.calls.flat().filter((e) => e.type === "turn.completed")).toHaveLength(0);
    } finally {
      s.handle.close();
    }
  });

  it.each(["item/completed"])("releases held sends when automatic compaction finishes via %s, before the work turn ends", async (method) => {
    const s = server();
    let delivery: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(s.handle.canSteer).toBe(true));
      s.notify("item/started", { threadId: "thread-1", turnId: "work-1", item: { id: "auto", type: "contextCompaction" } });
      delivery = s.handle.send("A correction", ["/tmp/correction.png"]);
      await new Promise(setImmediate);
      expect(s.calls.filter((c) => c.method === "turn/steer")).toHaveLength(0);
      s.notify(method, { threadId: "thread-1", turnId: "work-1", item: { id: "auto", type: "contextCompaction" } });
      await new Promise(setImmediate);
      expect(s.handle.compacting).toBe(false);
      expect(s.handle.canSteer).toBe(true);
      expect(s.calls.filter((c) => c.method === "turn/steer")).toEqual([
        expect.objectContaining({
          params: {
            threadId: "thread-1",
            expectedTurnId: "work-1",
            input: [
              { type: "text", text: "A correction" },
              { type: "localImage", path: "/tmp/correction.png" },
            ],
          },
        }),
      ]);
      expect(s.calls.filter((c) => c.method === "turn/start")).toHaveLength(1);
    } finally {
      s.finish("work-1");
      await delivery;
      s.handle.close();
    }
  });

  it("rejects a pending send if the provider disconnects rather than hanging forever", async () => {
    const s = server();
    await vi.waitFor(() => expect(s.handle.canSteer).toBe(true));
    s.steering.hold = true;
    const delivery = s.handle.send("Pending input");
    const rejected = expect(delivery).rejects.toThrow("process exited");
    await vi.waitFor(() => expect(s.steering.replies).toHaveLength(1));
    s.handle.close();
    await rejected;
  });

  it("keeps manual compaction blocked after its item completes until the maintenance turn succeeds", async () => {
    const s = server();
    try {
      await vi.waitFor(() => expect(s.handle.canSteer).toBe(true));
      s.finish("work-1");
      const compact = s.handle.compact();
      await vi.waitFor(() => expect(s.handle.compacting).toBe(true));
      s.notify("item/completed", { threadId: "thread-1", turnId: "compact-1", item: { id: "compact-item", type: "contextCompaction" } });
      const delivery = s.handle.send("After manual compaction");
      await new Promise(setImmediate);
      expect(s.handle.compacting).toBe(true);
      expect(s.calls.filter((c) => c.method === "turn/start")).toHaveLength(1);
      s.finish("compact-1");
      await Promise.all([compact, delivery]);
      expect(s.calls.filter((c) => c.method === "turn/start")).toHaveLength(2);
    } finally {
      s.handle.close();
    }
  });
});

describe("Codex Fast mode", () => {
  it.each([
    [false, "existing", false, "thread/resume"],
    [true, "existing", true, "thread/fork"],
  ] as const)("sets fast=%s on %s (fork=%s) and subsequent turns", async (fastMode, resumeSessionId, forkSession, method) => {
    const s = server("autonomous", { fastMode, ...(resumeSessionId ? { resumeSessionId, forkSession } : {}) });
    try {
      await vi.waitFor(() => expect(s.calls.some((c) => c.method === "turn/start")).toBe(true));
      const serviceTier = fastMode ? "priority" : "default";
      expect(s.calls.find((c) => c.method === method)?.params.serviceTier).toBe(serviceTier);
      expect(s.calls.find((c) => c.method === "turn/start")?.params.serviceTier).toBe(serviceTier);
      s.finish("work-1");
      await s.handle.send("Next turn");
      expect(s.calls.filter((c) => c.method === "turn/start")).toHaveLength(2);
      expect(s.calls.filter((c) => c.method === "turn/start").every((c) => c.params.serviceTier === serviceTier)).toBe(true);
      expect(vi.mocked(spawn).mock.lastCall?.[1]).toContain(`service_tier=${JSON.stringify(serviceTier)}`);
    } finally {
      s.handle.close();
    }
  });
});
