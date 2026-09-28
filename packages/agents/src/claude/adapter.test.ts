import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fileBoundaryUrl, type AgentEvent } from "@openorc/protocol";
import { ClaudeAdapter, ultracodeFallbackNotice } from "./adapter.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, writeFileSync: vi.fn(original.writeFileSync) };
});

type MockProcess = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number | undefined;
  exitCode: number | null;
  signalCode: string | null;
  kill: (signal?: string) => boolean;
};

function mockProcess(pid: number | undefined = undefined): MockProcess {
  const proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid,
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: vi.fn(() => {
      proc.exitCode = 0;
      proc.emit("exit", 0);
      proc.emit("close", 0);
      return true;
    }),
  }) as MockProcess;
  // Like the CLI, the mock exits once its input ends.
  proc.stdin.on("finish", () =>
    setImmediate(() => {
      if (proc.exitCode === null) {
        proc.exitCode = 0;
        proc.emit("exit", 0);
        proc.emit("close", 0);
      }
    }),
  );
  vi.mocked(spawn).mockReturnValue(proc as unknown as ChildProcess);
  return proc;
}

/** Lines the adapter wrote to the process so far. */
function written(proc: MockProcess): Record<string, unknown>[] {
  const chunk = proc.stdin.read() as Buffer | null;
  return chunk
    ? chunk
        .toString("utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const launch = { revision: 0, binary: "claude", env: process.env };

describe("Claude stream-json process", () => {
  it("removes the private MCP directory when writing its config fails before spawn", () => {
    let configFile: string | undefined;
    vi.mocked(writeFileSync).mockImplementationOnce((file) => {
      configFile = String(file);
      throw new Error("config write failed");
    });

    expect(() =>
      new ClaudeAdapter().start({ runId: "write-failed", agent: "claude", cwd: process.cwd(), prompt: "Hi", permissionMode: "trusted", mcpUrl: "http://127.0.0.1:1234/mcp/private" }, launch),
    ).toThrow("config write failed");
    expect(configFile).toBeDefined();
    expect(existsSync(path.dirname(configFile!))).toBe(false);
  });

  it("removes the private MCP directory when later argument construction fails", () => {
    vi.mocked(writeFileSync).mockClear();
    const toolNames = new Proxy<string[]>(["task_context"], {
      get(target, property, receiver) {
        if (property === "map") throw new Error("tool arguments failed");
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() =>
      new ClaudeAdapter().start(
        {
          runId: "args-failed",
          agent: "claude",
          cwd: process.cwd(),
          prompt: "Hi",
          permissionMode: "trusted",
          internalMcp: { serverName: `openorc_${"a".repeat(32)}`, url: "http://127.0.0.1:1234/mcp/private", toolNames },
        },
        launch,
      ),
    ).toThrow("tool arguments failed");
    const configFile = String(vi.mocked(writeFileSync).mock.calls.find(([file]) => String(file).endsWith("/mcp.json"))?.[0]);
    expect(configFile).toContain("mcp.json");
    expect(existsSync(path.dirname(configFile))).toBe(false);
  });

  it("cleans the prepared connection when process creation throws", () => {
    let configFile: string | undefined;
    vi.mocked(spawn).mockImplementation((_binary, args) => {
      const values = args as string[];
      configFile = values[values.indexOf("--mcp-config") + 1];
      throw new Error("spawn rejected");
    });

    expect(() =>
      new ClaudeAdapter().start({ runId: "failed-create", agent: "claude", cwd: process.cwd(), prompt: "Hi", permissionMode: "trusted", mcpUrl: "http://127.0.0.1:1234/mcp/private" }, launch),
    ).toThrow("spawn rejected");
    expect(configFile).toBeDefined();
    expect(existsSync(configFile!)).toBe(false);
  });

  it("settles a failed launch and removes its private connection file", async () => {
    const proc = mockProcess();
    proc.kill = vi.fn(() => {
      proc.emit("close", null);
      return true;
    });
    const handle = new ClaudeAdapter().start(
      { runId: "failed-launch", agent: "claude", cwd: process.cwd(), prompt: "Hi", permissionMode: "trusted", mcpUrl: "http://127.0.0.1:1234/mcp/private" },
      launch,
    );
    const events: AgentEvent[] = [];
    handle.on("event", (event) => events.push(event));
    const args = vi.mocked(spawn).mock.lastCall?.[1] as string[];
    const configFile = args[args.indexOf("--mcp-config") + 1]!;
    expect(existsSync(configFile)).toBe(true);

    proc.emit("error", new Error("spawn ENOENT"));
    await handle.wait();
    expect(events.map((event) => event.type)).toEqual(["error", "session.completed"]);
    expect(events[0]).toMatchObject({ message: "spawn ENOENT", fatal: true });
    expect(events[1]).toMatchObject({ status: "error" });
    expect(existsSync(configFile)).toBe(false);
  });

  it("sends the prompt as the first stdin line and keeps the process for later turns", async () => {
    const proc = mockProcess();
    const handle = new ClaudeAdapter().start({ runId: "fixture", agent: "claude", cwd: process.cwd(), prompt: "First", attachments: ["/tmp/a.png"], permissionMode: "trusted" }, launch);
    const events: AgentEvent[] = [];
    handle.on("event", (event) => events.push(event));
    try {
      const args = vi.mocked(spawn).mock.lastCall?.[1] as string[];
      expect(args.slice(0, 3)).toEqual(["-p", "--input-format", "stream-json"]);
      expect(args).not.toContain("First");
      await tick();
      const [first] = written(proc);
      expect(first).toMatchObject({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: expect.stringContaining("First\n\nAttached file (open with the Read tool):\n- /tmp/a.png") }] },
      });
      expect(handle.canSteer).toBe(true);
      proc.stdout.write(
        `${JSON.stringify({ type: "system", subtype: "init", session_id: "fixture", model: "m" })}\n${JSON.stringify({ type: "result", subtype: "success", result: "One", num_turns: 1, duration_ms: 1 })}\n`,
      );
      await tick();
      expect(handle.canSteer).toBe(false);
      expect(proc.exitCode).toBeNull();
      await handle.send("Second");
      expect(handle.canSteer).toBe(true);
      expect(written(proc)).toEqual([expect.objectContaining({ type: "user", message: { role: "user", content: [{ type: "text", text: "Second" }] } })]);
    } finally {
      handle.close();
      await handle.wait();
    }
  });

  it("writes a mid-turn message during a turn, refuses one between turns, and treats queued input as a new turn", async () => {
    const proc = mockProcess();
    const handle = new ClaudeAdapter().start({ runId: "fixture", agent: "claude", cwd: process.cwd(), prompt: "Slow work", permissionMode: "trusted" }, launch);
    try {
      await tick();
      written(proc);
      await expect(handle.steer("Also do this")).resolves.toBe("accepted");
      expect(written(proc)).toEqual([expect.objectContaining({ type: "user" })]);
      proc.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "Done", num_turns: 1, duration_ms: 1 })}\n`);
      await tick();
      await expect(handle.steer("Too late")).resolves.toBe("unavailable");
      expect(written(proc)).toEqual([]);
      // The CLI starts a queued message as its own turn; the init line says so.
      proc.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "fixture", model: "m" })}\n`);
      await tick();
      expect(handle.canSteer).toBe(true);
    } finally {
      handle.close();
      await handle.wait();
    }
  });

  it("reports a turn the CLI starts from mid-turn input as the steered turn carrying on", async () => {
    const proc = mockProcess();
    const handle = new ClaudeAdapter({ followUpGraceMs: 30 }).start({ runId: "fixture", agent: "claude", cwd: process.cwd(), prompt: "Slow work", permissionMode: "trusted" }, launch);
    const events: AgentEvent[] = [];
    handle.on("event", (event) => events.push(event));
    try {
      await tick();
      await expect(handle.steer("Also do this")).resolves.toBe("accepted");
      proc.stdout.write(
        `${JSON.stringify({ type: "result", subtype: "success", result: "Story", num_turns: 1, duration_ms: 5, total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } })}\n`,
      );
      await tick();
      expect(events.filter((event) => event.type === "turn.completed")).toEqual([]);
      expect(handle.canSteer).toBe(false);
      await expect(handle.steer("During the hold")).resolves.toBe("unavailable");
      proc.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "fixture", model: "m" })}\n`);
      await tick();
      expect(events.filter((event) => event.type === "turn.started")).toEqual([]);
      expect(handle.canSteer).toBe(true);
      proc.stdout.write(
        `${JSON.stringify({ type: "result", subtype: "success", result: "Also done", num_turns: 1, duration_ms: 7, total_cost_usd: 0.03, usage: { input_tokens: 1, output_tokens: 1 } })}\n`,
      );
      await tick();
      const completed = events.filter((event) => event.type === "turn.completed");
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({ resultText: "Also done", durationMs: 12, usage: { costUsd: 0.03 } });
      expect(handle.canSteer).toBe(false);
    } finally {
      handle.close();
      await handle.wait();
    }
  });

  it("releases a steered turn's result once no continuation follows", async () => {
    const proc = mockProcess();
    const handle = new ClaudeAdapter({ followUpGraceMs: 20 }).start({ runId: "fixture", agent: "claude", cwd: process.cwd(), prompt: "Slow work", permissionMode: "trusted" }, launch);
    const events: AgentEvent[] = [];
    handle.on("event", (event) => events.push(event));
    try {
      await tick();
      await expect(handle.steer("Taken at a tool boundary")).resolves.toBe("accepted");
      proc.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "Done", num_turns: 2, duration_ms: 5 })}\n`);
      await tick();
      expect(events.filter((event) => event.type === "turn.completed")).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(events.filter((event) => event.type === "turn.completed")).toEqual([expect.objectContaining({ resultText: "Done", durationMs: 5 })]);
      expect(handle.canSteer).toBe(false);
      // The next turn from the app is ordinary again.
      await handle.send("Next");
      proc.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "Next done", num_turns: 1, duration_ms: 1 })}\n`);
      await tick();
      expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(2);
    } finally {
      handle.close();
      await handle.wait();
    }
  });

  it("interrupts through the control channel and reports the stopped turn as cancelled", async () => {
    const proc = mockProcess();
    const handle = new ClaudeAdapter().start({ runId: "fixture", agent: "claude", cwd: process.cwd(), prompt: "Long task", permissionMode: "trusted" }, launch);
    const events: AgentEvent[] = [];
    handle.on("event", (event) => events.push(event));
    try {
      await tick();
      written(proc);
      handle.interrupt();
      await tick();
      expect(written(proc)).toEqual([expect.objectContaining({ type: "control_request", request: { subtype: "interrupt" } })]);
      expect(proc.kill).not.toHaveBeenCalled();
      proc.stdout.write(`${JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, duration_ms: 1 })}\n`);
      await tick();
      const turn = events.find((event) => event.type === "turn.completed");
      expect(turn && turn.type === "turn.completed" && turn.status).toBe("cancelled");
      expect(proc.exitCode).toBeNull();
    } finally {
      handle.close();
      await handle.wait();
    }
  });

  it("reports background work that outlives its turn and hands its end to the turn that reports on it", async () => {
    const proc = mockProcess();
    const handle = new ClaudeAdapter({ followUpGraceMs: 30 }).start({ runId: "fixture", agent: "claude", cwd: process.cwd(), prompt: "Trace it in the background", permissionMode: "trusted" }, launch);
    const events: AgentEvent[] = [];
    handle.on("event", (event) => events.push(event));
    const lifecycle = () =>
      events.flatMap((e) => {
        if (e.type === "background.updated") return [`background ${e.running}`];
        if (e.type === "turn.started" || e.type === "turn.completed") return [e.type];
        return [];
      });
    const out = (...lines: unknown[]) => proc.stdout.write(lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
    try {
      await tick();
      out(
        { type: "system", subtype: "init", session_id: "fixture", model: "m" },
        { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "w1", task_type: "local_workflow", description: "Trace" }] },
        { type: "result", subtype: "success", result: "It runs in the background.", num_turns: 1, duration_ms: 1 },
      );
      await tick();
      expect(lifecycle()).toEqual(["turn.started", "background 1", "turn.completed"]);
      // The workflow finishes, and a moment later the CLI brings the agent back to report on it.
      out({ type: "system", subtype: "background_tasks_changed", tasks: [] }, { type: "system", subtype: "task_notification", task_id: "w1", status: "completed", summary: "Traced" });
      await tick();
      expect(lifecycle()).toHaveLength(3);
      out({ type: "system", subtype: "init", session_id: "fixture", model: "m" });
      await tick();
      expect(lifecycle().slice(3)).toEqual(["turn.started", "background 0"]);
    } finally {
      handle.close();
      await handle.wait();
    }
  });

  it("stops background work between turns and reports its end once no turn follows", async () => {
    const proc = mockProcess();
    const handle = new ClaudeAdapter({ followUpGraceMs: 20 }).start({ runId: "fixture", agent: "claude", cwd: process.cwd(), prompt: "Serve the preview", permissionMode: "trusted" }, launch);
    const events: AgentEvent[] = [];
    handle.on("event", (event) => events.push(event));
    const counts = () => events.flatMap((e) => (e.type === "background.updated" ? [e.running] : []));
    try {
      await tick();
      written(proc);
      proc.stdout.write(
        `${JSON.stringify({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "b1", task_type: "local_bash", description: "Serve" }] })}\n${JSON.stringify({ type: "result", subtype: "success", result: "Serving", num_turns: 1, duration_ms: 1 })}\n`,
      );
      await tick();
      handle.interrupt();
      await tick();
      expect(written(proc)).toEqual([expect.objectContaining({ type: "control_request", request: { subtype: "stop_task", task_id: "b1" } })]);
      proc.stdout.write(`${JSON.stringify({ type: "system", subtype: "background_tasks_changed", tasks: [] })}\n`);
      await tick();
      expect(counts()).toEqual([1]);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(counts()).toEqual([1, 0]);
      expect(events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    } finally {
      handle.close();
      await handle.wait();
    }
  });

  it("compacts in place through /compact and settles on the compaction the stream reports", async () => {
    const proc = mockProcess();
    const handle = new ClaudeAdapter().start({ runId: "fixture", agent: "claude", cwd: process.cwd(), prompt: "Hi", permissionMode: "trusted" }, launch);
    const events: AgentEvent[] = [];
    handle.on("event", (event) => events.push(event));
    try {
      await tick();
      written(proc);
      expect(handle.canCompact).toBe(true);
      await expect(handle.compact()).rejects.toThrow(/current turn/);
      proc.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "Hello", num_turns: 1, duration_ms: 1 })}\n`);
      await tick();
      const compacting = handle.compact();
      await tick();
      expect(written(proc)).toEqual([expect.objectContaining({ type: "user", message: { role: "user", content: [{ type: "text", text: "/compact" }] } })]);
      expect(handle.canSteer).toBe(false);
      const lines = [
        { type: "system", subtype: "status", status: "compacting" },
        { type: "system", subtype: "status", status: null, compact_result: "success" },
        { type: "system", subtype: "init", session_id: "fixture", model: "m" },
        { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 10, post_tokens: 2 } },
        { type: "result", subtype: "success", num_turns: 0, duration_ms: 1 },
      ];
      proc.stdout.write(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      await expect(compacting).resolves.toBeUndefined();
      expect(events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
      expect(events.filter((e) => e.type === "turn.started")).toHaveLength(0);
      expect(handle.canSteer).toBe(false);
      // A failed compaction rejects and leaves the process usable.
      const failing = handle.compact();
      await tick();
      proc.stdout.write(
        `${JSON.stringify({ type: "system", subtype: "status", status: "compacting" })}\n${JSON.stringify({ type: "system", subtype: "status", status: null, compact_result: "error", error: "Nothing to compact" })}\n`,
      );
      await expect(failing).rejects.toThrow(/Nothing to compact/);
      await handle.send("Still here");
      expect(handle.canSteer).toBe(true);
    } finally {
      handle.close();
      await handle.wait();
    }
  });

  it("changes the model and effort of an idle session through control requests the CLI answers", async () => {
    const proc = mockProcess();
    const handle = new ClaudeAdapter().start({ runId: "fixture", agent: "claude", cwd: process.cwd(), prompt: "First", model: "claude-sonnet-5", effort: "medium", permissionMode: "trusted" }, launch);
    try {
      await tick();
      written(proc);
      expect(handle.canApplySettings).toBe(true);
      await expect(handle.applySettings({ model: "claude-opus-5-5" })).rejects.toThrow("Wait for the current turn to finish");
      proc.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "Done", num_turns: 1, duration_ms: 1 })}\n`);
      await tick();
      const applying = handle.applySettings({ model: "claude-opus-5-5", effort: "high", fastMode: true });
      await tick();
      const [setModel] = written(proc);
      expect(setModel).toMatchObject({ type: "control_request", request: { subtype: "set_model", model: "claude-opus-5-5" } });
      proc.stdout.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: setModel!["request_id"], response: {} } })}\n`);
      await tick();
      const [setEffort] = written(proc);
      expect(setEffort).toMatchObject({ type: "control_request", request: { subtype: "apply_flag_settings", settings: { effortLevel: "high" } } });
      proc.stdout.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: setEffort!["request_id"] } })}\n`);
      await tick();
      const [setFast] = written(proc);
      expect(setFast).toMatchObject({ type: "control_request", request: { subtype: "apply_flag_settings", settings: { fastMode: true } } });
      proc.stdout.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: setFast!["request_id"] } })}\n`);
      await expect(applying).resolves.toBeUndefined();
      // The session now asks for Fast, so a turn served at standard speed is reported.
      const events: AgentEvent[] = [];
      handle.on("event", (event) => events.push(event));
      proc.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "Slow", num_turns: 1, duration_ms: 1, fast_mode_state: "off", fast_mode_disabled_reason: "free" })}\n`);
      await tick();
      expect(events.filter((event) => event.type === "message.completed")).toEqual([expect.objectContaining({ role: "system", text: expect.stringContaining("standard speed") })]);
      // A rejected request is reported so the caller can restart instead.
      const refused = handle.applySettings({ model: "claude-haiku-4-5" });
      await tick();
      const [again] = written(proc);
      proc.stdout.write(`${JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: again!["request_id"], error: "Unknown model" } })}\n`);
      await expect(refused).rejects.toThrow("Unknown model");
      // No line of another id settles a request; the process ending does.
      const orphaned = handle.applySettings({ effort: "low" });
      await tick();
      written(proc);
      proc.stdout.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "someone-else" } })}\n`);
      await tick();
      proc.kill();
      await expect(orphaned).rejects.toThrow("Claude exited before answering");
    } finally {
      handle.close();
      await handle.wait();
    }
  });

  it("times out an unanswered settings request without settling a later request from its late response", async () => {
    const proc = mockProcess();
    const options = { controlReplyTimeoutMs: 20 };
    const handle = new ClaudeAdapter(options).start({ runId: "fixture", agent: "claude", cwd: process.cwd(), prompt: "First", permissionMode: "trusted" }, launch);
    try {
      await tick();
      written(proc);
      proc.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", num_turns: 1, duration_ms: 1 })}\n`);
      await tick();
      const timedOut = handle.applySettings({ model: "slow-model" });
      await tick();
      const [first] = written(proc);
      await expect(timedOut).rejects.toThrow("Claude Code did not answer the settings change.");

      // The next request waits as long as it needs, so a busy machine can't time it out before the test answers it.
      options.controlReplyTimeoutMs = 60_000;
      const next = handle.applySettings({ effort: "high" });
      await tick();
      const [second] = written(proc);
      expect(second?.["request_id"]).not.toBe(first?.["request_id"]);
      proc.stdout.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: first?.["request_id"] } })}\n`);
      await tick();
      proc.stdout.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: second?.["request_id"] } })}\n`);
      await expect(next).resolves.toBeUndefined();
    } finally {
      handle.close();
      await handle.wait();
    }
  });

  it("closes an idle process by ending its input and a busy one by stopping it", async () => {
    const idle = mockProcess();
    const idleHandle = new ClaudeAdapter().start({ runId: "idle", agent: "claude", cwd: process.cwd(), prompt: "Hi", permissionMode: "trusted" }, launch);
    await tick();
    idle.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "Hello", num_turns: 1, duration_ms: 1 })}\n`);
    await tick();
    idleHandle.close();
    expect(idle.stdin.writableEnded).toBe(true);
    // No signal before the CLI had the chance to exit on its own; exit cleanup may still signal afterwards.
    expect(idle.kill).not.toHaveBeenCalled();
    await idleHandle.wait();

    const busy = mockProcess();
    const busyHandle = new ClaudeAdapter().start({ runId: "busy", agent: "claude", cwd: process.cwd(), prompt: "Hi", permissionMode: "trusted" }, launch);
    await tick();
    busyHandle.close();
    expect(busy.kill).toHaveBeenCalled();
    await busyHandle.wait();
  });
});

describe("Claude ultracode", () => {
  it("posts one system notice when the session cannot run workflows", async () => {
    const proc = mockProcess();
    const handle = new ClaudeAdapter().start({ runId: "fixture", agent: "claude", cwd: process.cwd(), prompt: "Go", effort: "ultracode", permissionMode: "trusted" }, launch);
    const events: AgentEvent[] = [];
    handle.on("event", (event) => events.push(event));
    try {
      proc.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "fixture", model: "m", tools: ["Read", "Edit"] })}\n`);
      await tick();
      const notices = events.filter((event) => event.type === "message.completed");
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ role: "system", messageId: "ultracode-fixture", text: expect.stringContaining("Ultracode") });
    } finally {
      handle.close();
      await handle.wait();
    }
  });

  it("names the cause when an ultracode session lists its tools without Workflow", () => {
    expect(ultracodeFallbackNotice({ effort: "ultracode", mode: "plan", permissionMode: "autonomous" }, ["Read"])).toContain("while planning");
    expect(ultracodeFallbackNotice({ effort: "ultracode", permissionMode: "trusted" }, ["Read"])).toContain("Autonomous permissions");
    expect(ultracodeFallbackNotice({ effort: "ultracode", permissionMode: "autonomous" }, ["Read"])).toContain("enable them in its settings");
    expect(ultracodeFallbackNotice({ effort: "ultracode", permissionMode: "autonomous" }, ["Read", "Workflow"])).toBeNull();
    expect(ultracodeFallbackNotice({ effort: "ultracode", permissionMode: "autonomous" }, undefined)).toBeNull();
    expect(ultracodeFallbackNotice({ effort: "max", permissionMode: "trusted" }, ["Read"])).toBeNull();
  });
});

describe("Claude Fast mode", () => {
  it.skipIf(process.platform === "win32")("contains exit cleanup denial and waits until the descendant group is gone", async () => {
    const proc = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: 987653,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    });
    vi.mocked(spawn).mockReturnValue(proc as unknown as ChildProcess);
    let exists = true;
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (!exists) throw Object.assign(new Error("Gone"), { code: "ESRCH" });
      if (signal !== 0) throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      return true;
    });
    const handle = new ClaudeAdapter().start({ runId: "cleanup-fixture", agent: "claude", cwd: process.cwd(), prompt: "Fixture only", permissionMode: "trusted" }, launch);
    const events: unknown[] = [];
    handle.on("event", (event) => events.push(event));
    try {
      expect(() => proc.emit("exit", 0)).not.toThrow();
      proc.emit("close", 0);
      let finished = false;
      const done = handle.wait().then(() => {
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

  it.each([undefined])("scopes fast=%s to this process, including resumed sessions", async (fastMode) => {
    const proc = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: undefined,
      exitCode: null as number | null,
      signalCode: null,
      kill: () => {
        proc.exitCode = 0;
        proc.emit("exit", 0);
        proc.emit("close", 0);
        return true;
      },
    });
    vi.mocked(spawn).mockReturnValue(proc as unknown as ChildProcess);
    const handle = new ClaudeAdapter().start(
      {
        runId: "fixture",
        agent: "claude",
        cwd: process.cwd(),
        prompt: "Fixture only",
        model: "claude-opus-5",
        effort: "high",
        permissionMode: "trusted",
        resumeSessionId: "existing",
        ...(fastMode === undefined ? {} : { fastMode }),
      },
      launch,
    );
    try {
      const args = vi.mocked(spawn).mock.lastCall?.[1] as string[];
      expect(JSON.parse(args[args.indexOf("--settings") + 1]!)).toMatchObject({ fastMode: Boolean(fastMode) });
      expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-5");
      expect(args[args.indexOf("--effort") + 1]).toBe("high");
      expect(args[args.indexOf("--resume") + 1]).toBe("existing");
    } finally {
      handle.close();
      await handle.wait();
    }
  });
});

describe("OpenOrc's MCP address", () => {
  it("reaches Claude in a private file, never in argv, and the file goes with the process", async () => {
    mockProcess();
    const url = "http://127.0.0.1:1234/mcp/secret-token";
    const handle = new ClaudeAdapter().start({ runId: "mcp-file", agent: "claude", cwd: process.cwd(), prompt: "Hi", mode: "act", permissionMode: "trusted", mcpUrl: url }, launch);
    const args = vi.mocked(spawn).mock.lastCall![1] as string[];
    expect(args.some((arg) => arg.includes("secret-token"))).toBe(false);
    const file = args[args.indexOf("--mcp-config") + 1]!;
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mcpServers: { openorc: { type: "http", url } } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    handle.close();
    await handle.wait();
    expect(existsSync(file)).toBe(false);
  });
});

describe("enforced execution modes", () => {
  it.each(["review", "trusted", "plan"] as const)("gates tools for %s on resumed sessions", (mode) => {
    const proc = mockProcess();
    const configDir = mkdtempSync(path.join(tmpdir(), "openorc-claude-config-"));
    const internalMcp = { serverName: `openorc_${"b".repeat(32)}`, url: "http://127.0.0.1:1/mcp/modes-secret", toolNames: ["browser"] };
    const handle = new ClaudeAdapter().start(
      {
        runId: "modes",
        agent: "claude",
        cwd: process.cwd(),
        prompt: "Inspect",
        mode: mode === "plan" ? "plan" : "act",
        permissionMode: mode === "plan" ? "review" : mode,
        resumeSessionId: "existing",
        internalMcp,
      },
      { ...launch, env: { ...process.env, CLAUDE_CONFIG_DIR: configDir } },
    );
    /** The boundary the file-boundary hook sends to OpenOrc, read from its private curl config. */
    const boundaryConfig = (hook: { command: string }) => readFileSync(/-K '([^']+)'/.exec(hook.command)![1]!, "utf8");
    try {
      const args = vi.mocked(spawn).mock.lastCall![1] as string[];
      const settings = JSON.parse(args[args.indexOf("--settings") + 1]!);
      expect(args).toContain("--strict-mcp-config");
      const tools = args[args.indexOf("--tools") + 1]!.split(",");
      expect(tools).not.toContain("Agent");
      if (mode === "plan") {
        expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
        expect(settings.permissions.deny).toEqual(expect.arrayContaining(["Bash", "NotebookEdit"]));
        expect(settings.plansDirectory).toBeUndefined();
        expect(settings.hooks.PreToolUse[0].matcher).toBe("Edit|Write");
        expect(boundaryConfig(settings.hooks.PreToolUse[0].hooks[0])).toContain(fileBoundaryUrl(internalMcp.url, { root: path.join(configDir, "plans"), cwd: process.cwd(), outside: "deny" }));
      } else {
        expect(settings.permissions.ask).toContain("Bash");
        expect(settings.sandbox.autoAllowBashIfSandboxed).toBe(false);
        if (mode === "review") expect(settings.permissions.ask).toEqual(expect.arrayContaining(["Edit", "Write", "NotebookEdit"]));
        if (mode === "trusted") {
          expect(settings.hooks.PreToolUse[0].matcher).toBe("Edit|Write|NotebookEdit");
          expect(boundaryConfig(settings.hooks.PreToolUse[0].hooks[0])).toContain(fileBoundaryUrl(internalMcp.url, { root: process.cwd(), cwd: process.cwd(), outside: "ask" }));
        }
      }
      expect(args.some((arg) => arg.includes("modes-secret"))).toBe(false);
    } finally {
      handle.close();
      proc.kill();
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe("Claude MCP startup", () => {
  const internalMcp = { serverName: `openorc_${"a".repeat(32)}`, url: "http://127.0.0.1:1/mcp", toolNames: ["browser"] };
  const spawned = () => {
    const [, args, options] = vi.mocked(spawn).mock.lastCall!;
    return { args: args as string[], env: (options as { env: NodeJS.ProcessEnv }).env };
  };
  const start = (spec: { internalMcp?: typeof internalMcp }, env: NodeJS.ProcessEnv) => {
    mockProcess();
    return new ClaudeAdapter().start({ runId: "mcp-startup", agent: "claude", cwd: process.cwd(), prompt: "Fixture only", permissionMode: "autonomous", ...spec }, { ...launch, env });
  };

  it("keeps the user's MCP servers from holding the first turn, while the app's approval server is still awaited", async () => {
    const handle = start({ internalMcp }, { ...process.env, CLAUDE_CODE_MCP_STARTUP_WAIT_MS: undefined });
    try {
      const { args, env } = spawned();
      expect(env["CLAUDE_CODE_MCP_STARTUP_WAIT_MS"]).toBe("0");
      // Claude Code waits for the server behind the permission prompt tool regardless of the cap.
      expect(args[args.indexOf("--permission-prompt-tool") + 1]).toBe(`mcp__${internalMcp.serverName}__approve`);
    } finally {
      handle.close();
      await handle.wait();
    }
  });
});
