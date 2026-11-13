import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, ApprovalDecision, ApprovalResolution, RunSpec } from "@openorc/protocol";
import { AcpAdapter, type AcpApprovalRequest } from "../acp/adapter.js";
import { ompAcp } from "./acp.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const SERVER = "openorc_0123456789abcdef0123456789abcdef";
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A scripted Oh My Pi on the far side of the pipes: it steers, and asks through forms as well as permission requests. */
function omp(overrides: Partial<RunSpec> = {}, decide: (request: AcpApprovalRequest) => Promise<ApprovalDecision | ApprovalResolution> = async () => "allow") {
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
      proc.exitCode = 143;
      proc.emit("exit", 143);
      proc.emit("close", 143);
      return true;
    },
  });
  vi.mocked(spawn).mockReturnValue(proc as unknown as ChildProcess);
  const calls: { id: number; method: string; params: Record<string, unknown> }[] = [];
  const notifications: { method: string; params: Record<string, unknown> }[] = [];
  const write = (message: unknown) => stdout.write(`${JSON.stringify(message)}\n`);
  const prompts: number[] = [];
  const answers = new Map<number, (result: unknown) => void>();
  let asked = 500;
  const configOptions = [
    {
      id: "mode",
      name: "Mode",
      type: "select",
      currentValue: "default",
      options: [
        { value: "default", name: "Default" },
        { value: "plan", name: "Plan" },
      ],
    },
    { id: "model", name: "Model", type: "select", currentValue: "anthropic/claude-haiku-5-5", options: [{ value: "anthropic/claude-haiku-5-5", name: "Claude Haiku 5.5" }] },
    { id: "thinking", name: "Thinking", type: "select", currentValue: "high", options: ["off", "auto", "low", "high"].map((value) => ({ value, name: value })) },
  ];
  let buffer = "";
  stdin.on("data", (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines.filter((each) => each.trim())) {
      const message = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown };
      if (message.method && message.id === undefined) {
        notifications.push({ method: message.method, params: message.params ?? {} });
        if (message.method === "session/cancel") {
          const id = prompts.shift();
          if (id !== undefined) write({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
        }
        continue;
      }
      if (message.method && message.id !== undefined) {
        const request = { id: message.id, method: message.method, params: message.params ?? {} };
        calls.push(request);
        const reply = (result: unknown) => write({ jsonrpc: "2.0", id: request.id, result });
        if (request.method === "initialize")
          reply({ protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "omp", version: "18.18.1" }, _meta: { steering: { supported: true } } });
        else if (request.method === "session/new") reply({ sessionId: "ses_1", configOptions });
        else if (request.method === "session/set_config_option") reply({ configOptions });
        else if (request.method === "session/prompt") prompts.push(request.id);
        else if (request.method === "_session/steering") reply({ outcome: prompts.length ? "injected" : "promptRequired", queue: "steering" });
        else reply({});
        continue;
      }
      answers.get(message.id!)?.(message.result);
    }
  });
  const events: AgentEvent[] = [];
  const handle = new AcpAdapter({ profile: ompAcp, onApproval: decide }).start(
    {
      runId: "run-1",
      agent: "omp",
      cwd: overrides.cwd ?? "/repo",
      prompt: "Hello",
      permissionMode: "review",
      internalMcp: { serverName: SERVER, url: "http://127.0.0.1:1/mcp", toolNames: ["ask_user"] },
      ...overrides,
    },
    { revision: 0, binary: "omp", env: { HOME: "/nowhere", PI_CODING_AGENT_DIR: "/nowhere/agent" } },
  );
  handle.on("event", (event) => events.push(event));
  /** The agent asks for a form and resolves with the answer. */
  const elicit = (message: string, properties: Record<string, unknown>) =>
    new Promise<unknown>((resolve) => {
      const id = ++asked;
      answers.set(id, resolve);
      write({ jsonrpc: "2.0", id, method: "elicitation/create", params: { mode: "form", sessionId: "ses_1", message, requestedSchema: { type: "object", properties } } });
    });
  const finish = () => write({ jsonrpc: "2.0", id: prompts.shift(), result: { stopReason: "end_turn" } });
  const launched = () => vi.mocked(spawn).mock.calls.at(-1)!;
  return { calls, notifications, events, handle, elicit, finish, launched, prompts };
}

const arg = (args: readonly string[], flag: string) => args[args.indexOf(flag) + 1];

describe("Oh My Pi over ACP", () => {
  it("starts with the conversation's approval mode, OpenOrc's settings overlay, forms on and no ask_user brief", async () => {
    const s = omp({ mode: "act", permissionMode: "trusted", effort: "low" });
    await vi.waitFor(() => expect(s.prompts).toHaveLength(1));
    const [, args] = s.launched();
    expect(args?.slice(0, 1)).toEqual(["acp"]);
    expect(arg(args!, "--approval-mode")).toBe("write");
    const overlay = readFileSync(arg(args!, "--config")!, "utf8");
    expect(overlay).toContain("approvalMode: write");
    expect(overlay).toContain("xdev: false");
    expect(overlay).toMatch(/async:\n {2}enabled: false/);
    const initialize = s.calls.find((call) => call.method === "initialize")!;
    expect(initialize.params["clientCapabilities"]).toMatchObject({ elicitation: { form: {} } });
    const set = s.calls.filter((call) => call.method === "session/set_config_option").map((call) => [call.params["configId"], call.params["value"]]);
    expect(set).toEqual([
      ["mode", "default"],
      ["thinking", "low"],
    ]);
    const prompt = JSON.stringify(s.calls.find((call) => call.method === "session/prompt")!.params["prompt"]);
    expect(prompt).not.toContain("ask_user");
    s.finish();
    await vi.waitFor(() => expect(s.events.some((event) => event.type === "turn.completed")).toBe(true));
    s.handle.close();
  });

  it("asks before every edit in Review, only before commands in Accept edits, and never in Autonomous", async () => {
    for (const [permissionMode, expected] of [
      ["review", "always-ask"],
      ["autonomous", "yolo"],
    ] as const) {
      const s = omp({ permissionMode });
      await vi.waitFor(() => expect(s.prompts).toHaveLength(1));
      expect(arg(s.launched()[1]!, "--approval-mode")).toBe(expected);
      s.handle.close();
    }
    const plan = omp({ mode: "plan", permissionMode: "autonomous" });
    await vi.waitFor(() => expect(plan.prompts).toHaveLength(1));
    expect(arg(plan.launched()[1]!, "--approval-mode")).toBe("always-ask");
    expect(plan.calls.some((call) => call.method === "session/set_config_option" && call.params["configId"] === "mode" && call.params["value"] === "plan")).toBe(true);
    plan.handle.close();
  });

  it("asks its questions on OpenOrc's card and fills its form with the answers", async () => {
    const requests: AcpApprovalRequest[] = [];
    const s = omp({}, async (request) => {
      requests.push(request);
      return { decision: "allow", answers: { q0: ["Blue"] } };
    });
    await vi.waitFor(() => expect(s.prompts).toHaveLength(1));
    const answer = await s.elicit("Which color?", {
      q0: {
        type: "string",
        title: "Which color?",
        oneOf: [
          { const: "Red", title: "Red" },
          { const: "Blue", title: "Blue" },
        ],
      },
      q0__other: { type: "string" },
    });
    expect(requests[0]).toMatchObject({ kind: "user_input", toolName: "question", input: { questions: [{ id: "q0", question: "Which color?", allowOther: true }] } });
    expect(answer).toEqual({ action: "accept", content: { q0: "Blue" } });
    expect(s.events.find((event) => event.type === "approval.resolved")).toMatchObject({ decision: "allow", answers: { q0: ["Blue"] } });
    s.handle.close();
  });

  it("asks before a tool through a form as an approval of that tool, and picks the choice for the decision", async () => {
    const requests: AcpApprovalRequest[] = [];
    const s = omp({}, async (request) => {
      requests.push(request);
      return "allow_for_run";
    });
    await vi.waitFor(() => expect(s.prompts).toHaveLength(1));
    const answer = await s.elicit("Allow tool: eval\nCode:\nprint(1)", { value: { type: "string", enum: ["Approve", "Approve eval for this session", "Deny"] } });
    expect(requests[0]).toMatchObject({ kind: "command", toolName: "eval", input: { input: "Code:\nprint(1)" }, onceOnly: false });
    expect(answer).toEqual({ action: "accept", content: { value: "Approve eval for this session" } });
    s.handle.close();
  });

  it("shows a proposed plan in OpenOrc, keeps the agent planning, and ends its turn as answered", async () => {
    const s = omp({ mode: "plan" });
    await vi.waitFor(() => expect(s.prompts).toHaveLength(1));
    const plan = "# Add a README\n\n1. Write it\n2. Link it";
    const answer = await s.elicit(`Approve plan "add-readme" and start implementation?\n\n${plan}`, { value: { type: "string", enum: ["Approve and execute", "Refine plan"] } });
    expect(answer).toEqual({ action: "accept", content: { value: "Refine plan" } });
    expect(s.events.find((event) => event.type === "plan.updated")).toMatchObject({ documentId: "plan", text: plan });
    await vi.waitFor(() => expect(s.notifications.some((note) => note.method === "session/cancel")).toBe(true));
    await vi.waitFor(() => expect(s.events.find((event) => event.type === "turn.completed")).toMatchObject({ status: "success" }));
    s.handle.close();
  });

  it("takes a message into the running turn, and only while a turn runs", async () => {
    const s = omp({ permissionMode: "autonomous" });
    await vi.waitFor(() => expect(s.prompts).toHaveLength(1));
    expect(s.handle.canSteer).toBe(true);
    await expect(s.handle.steer("Stop at five")).resolves.toBe("accepted");
    expect(s.calls.find((call) => call.method === "_session/steering")?.params).toMatchObject({ sessionId: "ses_1", prompt: [{ type: "text", text: "Stop at five" }] });
    s.finish();
    await vi.waitFor(() => expect(s.events.some((event) => event.type === "turn.completed")).toBe(true));
    expect(s.handle.canSteer).toBe(false);
    await expect(s.handle.steer("Too late")).resolves.toBe("unavailable");
    s.handle.close();
    await vi.waitFor(() => expect(s.events.find((event) => event.type === "session.completed")).toMatchObject({ status: "success" }));
  });

  it("reviews a pull request only without its own tools, extensions and language servers, from outside it", () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "omp-untrusted-"));
    folders.push(repo);
    const s = omp({ cwd: repo, untrustedCheckout: true });
    const [, args, options] = s.launched();
    expect(args).toEqual(expect.arrayContaining(["--no-extensions", "--no-lsp"]));
    expect((options as { cwd?: string }).cwd).not.toBe(repo);
    s.handle.close();

    mkdirSync(path.join(repo, ".omp"));
    expect(() => omp({ cwd: repo, untrustedCheckout: true })).toThrow("own tools and settings");
  });
});
