import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { commitAll, git } from "@openorc/git";
import { memories, plans, orchestration, settings, threads, runs, tasks } from "@openorc/db";
import { internalToolNames } from "@openorc/mcp";
import { DEFAULT_TEAM_LIMITS, type BrowserCommand, type Project, type CorePush, type PermissionPreset, type RunMode } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";
import { MAX_AGENT_HOPS } from "./thread-agent-tools.js";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

// This suite scripts streams, not OS processes. The real launch gate and crash
// ownership are exercised with child executables in agents/process-recovery.test.ts.
vi.mock("../../../agents/src/process-recovery.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../agents/src/process-recovery.js")>();
  return { ...original, spawnAgentProcess: (binary: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => spawn(binary, args, options) };
});

let root: string;
let dataDir: string;
let core: OpenOrc;
let project: Project;
const pushes: CorePush[] = [];
const browsed: BrowserCommand[] = [];
const questionEvents = (runId: string) =>
  pushes.flatMap((p) => (p.type === "frame" && p.frame.runId === runId ? p.frame.events : [])).filter((e) => e.type === "approval.requested" || e.type === "approval.resolved");
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-consent-repo-"));
  dataDir = await mkdtemp(path.join(os.tmpdir(), "openorc-consent-data-"));
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(path.join(root, "README.md"), "# Consent fixture\n");
  await commitAll(root, "init");
  core = await OpenOrc.create({
    dataDir,
    ephemeral: true,
    transport: {
      push(message) {
        pushes.push(message);
      },
    },
    // A page whose "pw" field holds a password: it refuses input until the host says the user allowed it.
    browser: async (_surface, command) => {
      browsed.push(command);
      return { url: "https://example.com/login", title: "Sign in", ...(command.action === "fill" && command.ref === "pw" && !command.secret ? { refused: "password" as const } : {}) };
    },
  });
  settings.set(core.db, "memory.enabled", "true");
  project = await core.projects.import(root);
});
afterAll(async () => {
  await core.close();
  await rm(root, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

/** Real core + adapter + JSON-RPC client; only the vendor subprocess is scripted. */
function provider(agent = "codex") {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: undefined,
    exitCode: null as number | null,
    signalCode: null,
    kill() {
      proc.exitCode = 0;
      proc.emit("exit", 0);
      proc.emit("close", 0);
      return true;
    },
  });
  vi.mocked(spawn).mockReturnValueOnce(proc as unknown as ChildProcess);
  const responses = new Map<number, unknown>();
  const requests = new Map<string, { config?: Record<string, unknown> }>();
  let ready = false;
  stdin.on("data", (data: Buffer) => {
    const message = JSON.parse(data.toString());
    if (!message.method) {
      responses.set(message.id, message);
      return;
    }
    requests.set(message.method, message.params);
    if (message.id === undefined) return;
    queueMicrotask(() => {
      if (message.method === "turn/start" || message.method === "session/prompt") ready = true;
      if (message.method === "session/prompt") return;
      const result = consentProtocolResponse(message.method, agent);
      stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
    });
  });
  return {
    exit: () => proc.kill(),
    ready: () => ready,
    responses,
    requests,
    request(method: string, params: unknown, id = 900) {
      stdout.write(JSON.stringify({ id, method, params }) + "\n");
    },
  };
}

async function mcpCall(url: string, name: string, args: Record<string, unknown>, signal = AbortSignal.timeout(4000)) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal,
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${raw}`);
  const payload = JSON.parse(
    raw.startsWith("{")
      ? raw
      : raw
          .split("\n")
          .find((line) => line.startsWith("data: "))!
          .slice(6),
  );
  expect(payload.error).toBeUndefined();
  expect(payload.result.isError).not.toBe(true);
  return JSON.parse(payload.result.content[0].text);
}

describe("app-owned MCP permissions", () => {
  it("clears a disconnected MCP question without consuming the next request", async () => {
    const thread = threads.insert(core.db, { projectId: project.id, title: "Disconnected question", agent: "opencode", model: "fixture", mode: "act", permissionMode: "autonomous" });
    const p = provider("opencode");
    const run = await core.runs.start({ scope: { thread, task: null }, project, agent: "opencode", model: "fixture", mode: "act", permissionMode: "autonomous", prompt: "Ask", resume: false });
    await vi.waitFor(() => expect(p.ready()).toBe(true));
    const controller = new AbortController();
    const url = (await core.mcpServer()).urlForRun(run.id);
    const input = { questions: [{ id: "note", question: "Any notes?" }] };
    const result = mcpCall(url, "ask_user", input, controller.signal);
    void result.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(core.runs.pending().filter((a) => a.runId === run.id)).toHaveLength(1));
      const old = core.runs.pending().find((a) => a.runId === run.id)!;
      controller.abort();
      await expect(result).rejects.toThrow();
      await vi.waitFor(() => expect(core.runs.pending().filter((a) => a.runId === run.id)).toHaveLength(0));
      const next = mcpCall(url, "ask_user", input);
      await vi.waitFor(() => expect(core.runs.pending().filter((a) => a.runId === run.id)).toHaveLength(1));
      const current = core.runs.pending().find((a) => a.runId === run.id)!;
      expect(current.approvalId).not.toBe(old.approvalId);
      core.runs.resolveApproval(run.id, old.approvalId, "allow", { note: ["Stale"] });
      expect(core.runs.pending().filter((a) => a.runId === run.id)).toHaveLength(1);
      core.runs.resolveApproval(run.id, current.approvalId, "allow", { note: ["Current"] });
      expect(await next).toMatchObject({ status: "answered", answers: { note: ["Current"] } });
    } finally {
      core.runs.close(run.id);
    }
  });

  it.each(["codex", "claude"] as const)("preserves %s native questions in Autonomous mode", async (agent) => {
    const thread = threads.insert(core.db, { projectId: project.id, title: "Native question", agent, model: "fixture", mode: "act", permissionMode: "autonomous" });
    const p = provider(agent);
    const run = await core.runs.start({ scope: { thread, task: null }, project, agent, model: "fixture", mode: "act", permissionMode: "autonomous", prompt: "Ask", resume: false });
    let response: Promise<unknown> | undefined;
    try {
      if (agent === "codex") {
        await vi.waitFor(() => expect(p.ready()).toBe(true));
        p.request("item/tool/requestUserInput", { questions: [{ id: "color", question: "Which color?", options: [{ label: "Blue", description: "" }] }] }, 999);
      } else {
        response = mcpCall((await core.mcpServer()).urlForRun(run.id), "approve", {
          tool_name: "AskUserQuestion",
          tool_use_id: "999",
          input: { questions: [{ question: "Which color?", options: [{ label: "Blue" }] }] },
        });
      }
      await vi.waitFor(() => expect(core.runs.pending().filter((a) => a.runId === run.id)).toHaveLength(1));
      const answers: Record<string, string[]> = agent === "codex" ? { color: ["Blue"] } : { "Which color?": ["Blue"] };
      core.runs.resolveApproval(run.id, "999", "allow", answers);
      if (response) expect(await response).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Which color?": "Blue" } } });
      else await vi.waitFor(() => expect(p.responses.get(999)).toMatchObject({ result: { answers: { color: { answers: ["Blue"] } } } }));
    } finally {
      core.runs.close(run.id);
    }
  });

  it.each(["decline", "interrupt", "exit", "close", "closeAndWait"])("settles ask_user on %s and ignores stale replies", async (action) => {
    const thread = threads.insert(core.db, { projectId: project.id, title: "Cancel question", agent: "opencode", model: "fixture", mode: "act", permissionMode: "autonomous" });
    const p = provider("opencode");
    const run = await core.runs.start({ scope: { thread, task: null }, project, agent: "opencode", model: "fixture", mode: "act", permissionMode: "autonomous", prompt: "Ask", resume: false });
    await vi.waitFor(() => expect(p.ready()).toBe(true));
    const url = (await core.mcpServer()).urlForRun(run.id);
    const input = { questions: [{ id: "note", question: "Any notes?" }] };
    const result = mcpCall(url, "ask_user", input);
    void result.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(core.runs.pending().filter((a) => a.runId === run.id)).toHaveLength(1));
      const pending = core.runs.pending().find((a) => a.runId === run.id)!;
      if (action === "decline") core.runs.resolveApproval(run.id, pending.approvalId, "deny");
      else if (action === "interrupt") core.runs.interrupt(run.id);
      else if (action === "exit") p.exit();
      else if (action === "close") core.runs.close(run.id);
      else await core.runs.closeAndWait(run.id);
      expect(await result).toEqual({ status: "cancelled", requestId: pending.approvalId });
      core.runs.resolveApproval(run.id, pending.approvalId, "allow", { note: ["Too late"] });
      expect(core.runs.pending().filter((a) => a.runId === run.id)).toHaveLength(0);
      await vi.waitFor(() => expect(questionEvents(run.id).filter((e) => e.type === "approval.resolved")).toEqual([expect.objectContaining({ approvalId: pending.approvalId, decision: "deny" })]));
      if (action === "interrupt") expect(await mcpCall(url, "ask_user", input)).toMatchObject({ status: "cancelled" });
      else if (action !== "decline") {
        await vi.waitFor(() => expect(core.runs.isLive(run.id)).toBe(false));
        await expect(mcpCall(url, "ask_user", input)).rejects.toThrow("HTTP 404: unknown run");
      }
    } finally {
      core.runs.close(run.id);
      await result.catch(() => undefined);
    }
  });

  it.each(["codex", "claude", "opencode"] as const)("keeps %s ask_user pending in Autonomous until correlated answers arrive", async (agent) => {
    const thread = threads.insert(core.db, { projectId: project.id, title: "Question", agent, model: "fixture", mode: "act", permissionMode: "autonomous" });
    const p = provider(agent);
    const run = await core.runs.start({ scope: { thread, task: null }, project, agent, model: "fixture", mode: "act", permissionMode: "autonomous", prompt: "Ask", resume: false });
    if (agent !== "claude") await vi.waitFor(() => expect(p.ready()).toBe(true));
    let settled = false;
    const result = mcpCall((await core.mcpServer()).urlForRun(run.id), "ask_user", {
      questions: [
        { id: "color", question: "Which color?", options: [{ label: "Blue" }, { label: "Red" }] },
        { id: "features", question: "Which features?", multiSelect: true, options: [{ label: "Search" }, { label: "Export" }] },
        { id: "note", question: "Any notes?" },
      ],
    }).then((value) => {
      settled = true;
      return value;
    });
    void result.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(core.runs.pending().filter((a) => a.runId === run.id)).toHaveLength(1));
      const pending = core.runs.pending().find((a) => a.runId === run.id)!;
      expect(core.runs.threadActivity(thread.id)).toBe("waiting");
      core.runs.applyThreadPermissions(thread);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(settled).toBe(false);
      const answers = { color: ["Blue"], features: ["Search", "Export"], note: ["Ship next week"] };
      expect(() => core.runs.resolveApproval(run.id, pending.approvalId, "allow")).toThrow("Answer every question");
      expect(() => core.runs.resolveApproval(run.id, pending.approvalId, "allow", { ...answers, color: ["Blue", "Red"] })).toThrow("Invalid selection");
      core.runs.resolveApproval("different-run", pending.approvalId, "allow", answers);
      expect(settled).toBe(false);
      core.runs.resolveApproval(run.id, pending.approvalId, "allow", answers);
      expect(await result).toEqual({ status: "answered", requestId: pending.approvalId, answers });
      expect(core.runs.pending().filter((a) => a.runId === run.id)).toHaveLength(0);
      await vi.waitFor(() =>
        expect(questionEvents(run.id)).toEqual([
          expect.objectContaining({
            type: "approval.requested",
            kind: "user_input",
            toolName: "ask_user",
            approvalId: pending.approvalId,
            input: { questions: [expect.objectContaining({ id: "color", isOther: true }), expect.objectContaining({ id: "features", multiSelect: true }), expect.objectContaining({ id: "note" })] },
          }),
          expect.objectContaining({ type: "approval.resolved", approvalId: pending.approvalId, decision: "allow", answers }),
        ]),
      );
    } finally {
      core.runs.close(run.id);
      await result.catch(() => undefined);
    }
  });

  it.each([
    ["codex", "review", "act"],
    ["codex", "trusted", "act"],
    ["codex", "review", "plan"],
    ["claude", "review", "act"],
    ["claude", "trusted", "act"],
    ["claude", "review", "plan"],
  ] as const)("allows app reads and backlog writes in %s / %s / %s, then still asks for external tools", async (agent, permissionMode, mode) => {
    const thread = threads.insert(core.db, { projectId: project.id, title: "Internal actions", agent, model: "fixture", mode, permissionMode });
    const input = { scope: { thread, task: null }, project, agent, model: "fixture", mode, permissionMode, prompt: "List tasks and save a backlog task", resume: false };
    const p = provider();
    const run = await core.runs.start(input);
    const args = vi.mocked(spawn).mock.lastCall![1] as string[];
    const url = (await core.mcpServer()).urlForRun(run.id);
    if (agent === "codex") await vi.waitFor(() => expect(p.ready()).toBe(true));
    const serverName =
      agent === "codex"
        ? Object.keys(p.requests.get("thread/start")!.config!)
            .find((key) => /^mcp_servers\..*\.url$/.test(key))!
            .split(".")[1]!
        : Object.keys(JSON.parse(await readFile(args[args.indexOf("--mcp-config") + 1]!, "utf8")).mcpServers)[0]!;
    expect(serverName).toMatch(/^openorc_[a-f0-9]{32}$/);
    const approval = vi.spyOn(core.runs, "requestApproval");
    const ask = async (name: string, id: number, source = serverName, external = false) => {
      if (agent === "codex") {
        p.request(
          external ? "item/commandExecution/requestApproval" : "mcpServer/elicitation/request",
          external ? { command: "external command", serverName: source } : { mode: "form", serverName: source, message: `Allow tool "${name}"?`, requestedSchema: { type: "object", properties: {} } },
          id,
        );
        return () => vi.waitFor(() => expect(p.responses.get(id)).toMatchObject({ result: expectedToolDecision(external, source === serverName) }));
      }
      const calls = approval.mock.calls.length;
      const response = mcpCall(url, "approve", { tool_name: external ? "Bash" : `mcp__${source}__${name}`, tool_use_id: String(id), input: {} });
      await vi.waitFor(() => expect(approval.mock.calls.length).toBeGreaterThan(calls));
      return async () => {
        expect(await response).toMatchObject({ behavior: external || source !== serverName ? "deny" : "allow" });
      };
    };
    try {
      if (agent === "codex") await vi.waitFor(() => expect(p.ready()).toBe(true));
      else {
        const allowed = args.slice(args.indexOf("--allowedTools") + 1);
        expect(allowed).toEqual(internalToolNames.map((name) => `mcp__${serverName}__${name}`));
        expect(args[args.indexOf("--permission-mode") + 1]).toBe(expectedPermissionMode(mode, permissionMode));
      }
      for (const [i, name] of ["task_list", "task_create"].entries()) {
        const resolved = await ask(name, 100 + i);
        expect(core.runs.pending().filter((a) => a.runId === run.id)).toHaveLength(0);
        await resolved();
        const result = await mcpCall(url, name, name === "task_create" ? { title: "Save for later", spec: "Do not implement", execution: "backlog" } : {});
        if (name === "task_create") {
          expect(result).toMatchObject({ started: false, task: { status: "backlog" } });
          expect(tasks.get(core.db, result.task.id)?.worktreePath).toBeNull();
          expect(runs.listForTask(core.db, result.task.id)).toHaveLength(0);
        }
      }
      for (const [i, source] of ["openorc", "unrelated", `${serverName}_copy`].entries()) {
        const resolved = await ask("task_create", 200 + i, source);
        if (mode !== "plan") {
          await vi.waitFor(() => expect(core.runs.pending().filter((a) => a.runId === run.id)).toHaveLength(1));
          core.runs.resolveApproval(run.id, String(200 + i), "deny");
        }
        await resolved();
      }
      const external = await ask("Bash", 300, serverName, true);
      if (mode !== "plan") {
        await vi.waitFor(() => expect(core.runs.pending().filter((a) => a.runId === run.id)).toHaveLength(1));
        core.runs.resolveApproval(run.id, "300", "deny");
      }
      await external();
      if (agent === "codex") {
        p.request("item/fileChange/requestApproval", { serverName, reason: "Change an external file" }, 302);
        if (mode !== "plan") {
          await vi.waitFor(() => expect(core.runs.pending().filter((a) => a.runId === run.id)).toHaveLength(1));
          core.runs.resolveApproval(run.id, "302", "deny");
        }
        await vi.waitFor(() => expect(p.responses.get(302)).toMatchObject({ result: { decision: "decline" } }));
        p.request(
          "mcpServer/elicitation/request",
          { serverName, mode: "form", message: "Choose a destination", requestedSchema: { type: "object", properties: { destination: { type: "string" } } } },
          301,
        );
        await vi.waitFor(() => expect(core.runs.pending().filter((a) => a.runId === run.id)).toHaveLength(1));
        core.runs.resolveApproval(run.id, "301", "deny");
      }
      expect(runs.get(core.db, run.id)?.permissionMode).toBe(permissionMode);
    } finally {
      for (const a of core.runs.pending().filter((a) => a.runId === run.id)) core.runs.resolveApproval(run.id, a.approvalId, "deny");
      approval.mockRestore();
      core.runs.close(run.id);
    }
  });

  it.each([
    ["codex", "task"],
    ["claude", "task"],
    ["codex", "forward"],
    ["claude", "forward"],
  ] as const)("preserves downstream permissions for %s / %s despite an autonomous app default", async (agent, action) => {
    core.settings.set({ defaultPermissionMode: "autonomous" });
    const parent = threads.insert(core.db, { projectId: project.id, title: "Parent", agent, model: "fixture", mode: "act", permissionMode: "trusted" });
    const parentProvider = provider();
    const parentRun = await core.runs.start({
      scope: { thread: parent, task: null },
      project,
      agent,
      model: "fixture",
      mode: "act",
      permissionMode: "trusted",
      prompt: "Delegate explicitly",
      resume: false,
    });
    const childProvider = action === "task" ? parentProvider : provider();
    let childId: string | undefined;
    try {
      if (action === "task") {
        const captured = await core.threads.toolCreate(parentRun.id, { title: "Child", spec: "Requested implementation", workspaceMode: parent.workspaceMode });
        await core.threads.toolStart(parentRun.id, captured.task.id);
        expect(core.runs.liveRunForTask(captured.task.id)).toBeNull();
        childId = parentRun.id;
      } else {
        const target = threads.insert(core.db, { projectId: project.id, title: "Target", agent, model: "fixture", mode: "act", permissionMode: "review", workspaceMode: "worktree" });
        await core.threads.toolThreadSend(parentRun.id, target.id, "Requested follow-up");
        childId = core.runs.liveRunForThread(target.id)!.id;
      }
      expect(runs.get(core.db, childId)?.permissionMode).toBe(action === "task" ? "trusted" : "review");
      let claudeResponse: Promise<unknown> | undefined;
      claudeResponse = mcpCall((await core.mcpServer()).urlForRun(childId), "approve", { tool_name: "Bash", tool_use_id: "400", input: { command: "external child command" } });
      await vi.waitFor(() => expect(core.runs.pending().filter((a) => a.runId === childId)).toHaveLength(1));
      core.runs.resolveApproval(childId, "400", "deny");
      if (claudeResponse) expect(await claudeResponse).toMatchObject({ behavior: "deny" });
      else await vi.waitFor(() => expect(childProvider.responses.get(400)).toMatchObject({ result: { decision: "decline" } }));
    } finally {
      // A task completion normally resumes its parent; keep the fixture from
      // launching a real provider after the scripted subprocess has closed.
      threads.update(core.db, parent.id, { archivedAt: Date.now() });
      for (const id of [parentRun.id, childId].filter((id): id is string => Boolean(id))) {
        for (const a of core.runs.pending().filter((a) => a.runId === id)) core.runs.resolveApproval(id, a.approvalId, "deny");
        await core.runs.closeAndWait(id);
      }
    }
  });
});

describe("Codex consent through the core", () => {
  const consent = { mode: "form", serverName: "node_repl", message: 'Allow Computer Use to use "OpenOrc"?', requestedSchema: { type: "object", properties: {} } };
  it.each([
    { label: "autonomous consent", permissionMode: "autonomous", mode: "act", params: consent, asks: false },
    { label: "trusted consent", permissionMode: "trusted", mode: "act", params: consent, asks: true },
    { label: "Plan consent", permissionMode: "autonomous", mode: "plan", params: consent, asks: false },
    {
      label: "a form needing data",
      permissionMode: "autonomous",
      mode: "act",
      params: { ...consent, requestedSchema: { type: "object", properties: { destination: { type: "string" } } } },
      asks: true,
    },
  ] as const)("handles $label with the effective run policy", async ({ permissionMode, mode, params, asks }) => {
    const thread = threads.insert(core.db, { projectId: project.id, title: "Consent", agent: "codex", model: "fixture", mode, permissionMode });
    const input = { scope: { thread, task: null }, project, agent: "codex" as const, model: "fixture", mode, permissionMode, prompt: "Consent regression", resume: false };
    const p = provider();
    const run = await core.runs.start(input);
    try {
      await vi.waitFor(() => expect(p.ready()).toBe(true));
      p.request("mcpServer/elicitation/request", params);
      if (asks) {
        await vi.waitFor(() => expect(core.runs.pending().filter((a) => a.runId === run.id)).toHaveLength(1));
        expect(p.responses.has(900)).toBe(false);
        core.runs.resolveApproval(run.id, "900", "deny");
      }
      await vi.waitFor(() => expect(p.responses.has(900)).toBe(true));
      expect(p.responses.get(900)).toMatchObject({ result: { action: asks || mode === "plan" ? "decline" : "accept" } });
      expect(core.runs.pending().filter((a) => a.runId === run.id)).toHaveLength(0);
    } finally {
      if (core.runs.pending().some((a) => a.runId === run.id)) core.runs.resolveApproval(run.id, "900", "deny");
      core.runs.close(run.id);
    }
  });
});

describe("native team permission ceiling", () => {
  it.each(["codex", "claude"] as const)("keeps %s native bypass visible while tightening the shared gate, then releases a parked request when Autonomous returns", async (agent) => {
    const thread = threads.insert(core.db, { projectId: project.id, title: "Native permission ceiling", agent, model: "fixture", mode: "act", permissionMode: "autonomous" });
    const p = provider();
    const run = await core.runs.start({
      scope: { thread, task: null },
      project,
      agent,
      model: "fixture",
      mode: "act",
      permissionMode: "autonomous",
      prompt: "Hold this native process",
      resume: false,
    });
    const team = orchestration.save(core.db, {
      projectId: project.id,
      expectedRevisionId: null,
      draft: {
        name: "Native ceiling",
        limits: DEFAULT_TEAM_LIMITS,
        discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: [] },
        members: [{ key: "lead", name: "Lead", managerKey: null, responsibility: "Coordinate", settings: { agent, model: "fixture", effort: null, fastMode: false } }],
      },
    });
    orchestration.createInstance(core.db, { threadId: thread.id, teamRevisionId: team.revision.id });
    let response: Promise<unknown> | undefined;
    try {
      if (agent === "codex") await vi.waitFor(() => expect(p.ready()).toBe(true));
      const args = vi.mocked(spawn).mock.lastCall![1] as string[];
      if (agent === "claude") expect(args[args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
      core.threads.update(thread.id, { permissionMode: "review" });
      expect(core.runs.threadPermissions(thread.id)).toMatchObject({ requested: "review", effective: "autonomous", pendingRestart: true });
      if (agent === "codex") p.request("item/commandExecution/requestApproval", { command: "fixture external command" }, 777);
      else response = core.runs.requestApproval(run.id, "777", "Bash", {});
      await vi.waitFor(() =>
        expect(
          core.runs
            .pending()
            .filter((item) => item.runId === run.id)
            .map((item) => item.approvalId),
        ).toEqual(["777"]),
      );
      expect(runs.get(core.db, run.id)?.permissionMode).toBe("autonomous");
      core.threads.update(thread.id, { permissionMode: "autonomous" });
      if (agent === "codex") await vi.waitFor(() => expect(p.responses.get(777)).toMatchObject({ result: { decision: "accept" } }));
      else expect(await response).toMatchObject({ decision: "allow" });
      expect(core.runs.pending().filter((item) => item.runId === run.id)).toEqual([]);
      expect(core.runs.threadPermissions(thread.id).pendingRestart).toBe(false);
    } finally {
      for (const approval of core.runs.pending().filter((item) => item.runId === run.id)) core.runs.resolveApproval(run.id, approval.approvalId, "deny");
      await core.runs.closeAndWait(run.id);
    }
  });
});

it("binds implementation to the reviewed plan revision and exports only on explicit request", async () => {
  const thread = threads.insert(core.db, { projectId: project.id, title: "Reviewed plan", agent: "claude", model: "fixture", mode: "plan", permissionMode: "review" });
  const source = runs.insert(core.db, { id: "plan-source", taskId: null, threadId: thread.id, agent: "claude", model: "fixture", mode: "plan", permissionMode: "review" });
  plans.write(core.db, source, "first", "# First revision", "native", true, Date.now());
  const first = core.threads.plans(thread.id)[0]!;
  plans.write(core.db, source, "second", "# Approved revision", "native", true, Date.now());
  const current = core.threads.plans(thread.id)[0]!;
  await expect(core.threads.implementPlan(thread.id, first.id, "review")).rejects.toThrow("latest completed revision");
  await expect(core.threads.exportPlan(thread.id, current.id, "../escape.md")).rejects.toThrow("without directories");
  const exported = await core.threads.exportPlan(thread.id, current.id, "explicit-plan.md");
  expect(exported.path).toBe(path.join(project.rootPath, "explicit-plan.md"));
  await expect(core.threads.exportPlan(thread.id, current.id, "explicit-plan.md")).rejects.toThrow();
  const p = provider("claude");
  try {
    const started = await core.threads.implementPlan(thread.id, current.id, "review");
    expect(started).toMatchObject({ mode: "act", permissionMode: "review" });
    expect((await core.threads.implementPlan(thread.id, current.id, "review")).id).toBe(started.id);
    await expect(core.threads.implementPlan(thread.id, current.id, "autonomous")).rejects.toThrow("different mode");
    core.runs.close(started.id);
  } finally {
    p.exit();
  }
});

it("presents Claude's ExitPlanMode plan as the conversation plan and keeps the run planning", async () => {
  const thread = threads.insert(core.db, { projectId: project.id, title: "Claude plan", agent: "claude", model: "fixture", mode: "plan", permissionMode: "review" });
  const run = runs.insert(core.db, { id: "claude-exit-plan", taskId: null, threadId: thread.id, agent: "claude", model: "fixture", mode: "plan", permissionMode: "review" });
  const result = await core.runs.requestApproval(run.id, "exit", "ExitPlanMode", { plan: "# Ship it", planFilePath: "/claude/plans/slug.md" });
  expect(result).toMatchObject({ decision: "deny", message: expect.stringContaining("saved your plan") });
  expect(core.runs.pending().filter((item) => item.runId === run.id)).toEqual([]);
  expect(core.threads.plans(thread.id)).toMatchObject([{ text: "# Ship it", source: "native", state: "draft" }]);
  expect(await core.runs.requestApproval(run.id, "empty", "ExitPlanMode", {})).toMatchObject({ decision: "deny", message: expect.stringContaining("no plan") });
  expect(core.threads.plans(thread.id)).toHaveLength(1);
});

it("offers plan_write only to Plan runs of harnesses without a native plan document", () => {
  const thread = threads.insert(core.db, { projectId: project.id, title: "OpenCode plan", agent: "opencode", model: "fixture", mode: "plan", permissionMode: "review" });
  const insert = (id: string, agent: "opencode" | "claude" | "codex", mode: "plan" | "act") =>
    runs.insert(core.db, { id, taskId: null, threadId: thread.id, agent, model: "fixture", mode, permissionMode: "review" }).id;
  expect(core.runs.acceptsPlanWrite(insert("opencode-plan", "opencode", "plan"))).toBe(true);
  expect(core.runs.acceptsPlanWrite(insert("opencode-act", "opencode", "act"))).toBe(false);
  expect(core.runs.acceptsPlanWrite(insert("claude-plan", "claude", "plan"))).toBe(false);
  expect(core.runs.acceptsPlanWrite(insert("codex-plan", "codex", "plan"))).toBe(false);
  // A finished run's connection cannot rewrite the conversation's plan.
  expect(() => core.runs.writePlan("opencode-plan", "# Late")).toThrow("running Plan conversation");
  expect(core.threads.plans(thread.id)).toEqual([]);
});

describe("app actions follow the conversation's mode", () => {
  /** An MCP call that may fail: returns whether it failed and its text. */
  async function toolCall(url: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(8000),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${raw}`);
    const payload = JSON.parse(
      raw.startsWith("{")
        ? raw
        : raw
            .split("\n")
            .find((line) => line.startsWith("data: "))!
            .slice(6),
    );
    if (payload.error) return { isError: true, text: String(payload.error.message) };
    return { isError: payload.result.isError === true, text: payload.result.content[0].text };
  }

  /** Runs a tool, allowing whatever approval it asks for, and reports what the mode did. */
  async function outcome(runId: string, url: string, name: string, args: Record<string, unknown>): Promise<string> {
    const call = toolCall(url, name, args);
    let finished = false;
    void call.finally(() => (finished = true));
    let asked = 0;
    while (!finished) {
      const pending = core.runs.pending().find((approval) => approval.runId === runId);
      if (pending) {
        asked += 1;
        core.runs.resolveApproval(runId, pending.approvalId, "allow");
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const { isError, text } = await call;
    const refused = isError || (name === "thread_send" && JSON.parse(text).delivered === false);
    if (refused) return /Plan mode/.test(text) ? "blocked" : `failed: ${text}`;
    return asked ? `asked ${asked}` : "allowed";
  }

  const modes: { label: string; mode: RunMode; permissionMode: PermissionPreset }[] = [
    { label: "Plan", mode: "plan", permissionMode: "review" },
    { label: "Review", mode: "act", permissionMode: "review" },
    { label: "Accept edits", mode: "act", permissionMode: "trusted" },
    { label: "Autonomous", mode: "act", permissionMode: "autonomous" },
  ];
  const expected: Record<string, string[]> = {
    // Plan, Review, Accept edits, Autonomous
    snapshot: ["allowed", "allowed", "allowed", "allowed"],
    click: ["blocked", "asked 1", "asked 1", "allowed"],
    password: ["blocked", "asked 2", "asked 2", "asked 1"],
    memory_record: ["blocked", "asked 1", "allowed", "allowed"],
    memory_feedback: ["blocked", "asked 1", "allowed", "allowed"],
    message_up: ["blocked", "asked 1", "asked 1", "allowed"],
    message_plan: ["allowed", "allowed", "allowed", "allowed"],
    task_list: ["allowed", "allowed", "allowed", "allowed"],
  };
  const cases = (["claude", "codex", "opencode"] as const).flatMap((agent) =>
    modes.map((mode, index) => ({ agent, ...mode, index })).filter(({ agent: kind, mode, permissionMode }) => kind !== "opencode" || mode === "plan" || permissionMode === "autonomous"),
  );

  it.each(cases)("$agent in $label", async ({ agent, mode, permissionMode, index }) => {
    const thread = threads.insert(core.db, { projectId: project.id, title: `Actions ${agent} ${mode} ${permissionMode}`, agent, model: "fixture", mode, permissionMode });
    const autonomous = threads.insert(core.db, { projectId: project.id, title: "Autonomous peer", agent: "codex", model: "fixture", mode: "act", permissionMode: "autonomous" });
    const planning = threads.insert(core.db, { projectId: project.id, title: "Planning peer", agent: "codex", model: "fixture", mode: "plan", permissionMode: "review" });
    const delivered = vi.spyOn(core.threads, "send").mockResolvedValue();
    const memory = memories.upsert(core.db, { projectId: project.id, type: "lesson", title: "Agent lesson", body: "Saved by an agent.", source: "agent" }).memory;
    const p = provider(agent);
    const run = await core.runs.start({ scope: { thread, task: null }, project, agent, model: "fixture", mode, permissionMode, prompt: "Act", resume: false });
    try {
      if (agent !== "claude") await vi.waitFor(() => expect(p.ready()).toBe(true));
      await vi.waitFor(() => expect(core.runs.isBusy(run.id)).toBe(true));
      const url = (await core.mcpServer()).urlForRun(run.id);
      const results = {
        snapshot: await outcome(run.id, url, "browser", { action: "snapshot" }),
        click: await outcome(run.id, url, "browser", { action: "click", ref: "button" }),
        password: await outcome(run.id, url, "browser", { action: "fill", ref: "pw", text: "hunter2" }),
        memory_record: await outcome(run.id, url, "memory_record", { type: "lesson", title: `Recorded in ${mode} ${permissionMode}`, body: "A finding." }),
        memory_feedback: await outcome(run.id, url, "memory_feedback", { id: memory.id, verdict: "helpful" }),
        message_up: await outcome(run.id, url, "thread_send", { id: autonomous.id, text: `Please act (${agent} ${index})` }),
        message_plan: await outcome(run.id, url, "thread_send", { id: planning.id, text: `Please plan (${agent} ${index})` }),
        task_list: await outcome(run.id, url, "task_list", {}),
      };
      expect(results).toEqual(Object.fromEntries(Object.entries(expected).map(([key, values]) => [key, values[index]])));
      // A password reaches the page only after the user allowed it.
      const passwords = browsed.filter((command) => command.action === "fill" && command.ref === "pw" && command.secret);
      expect(passwords.length > 0).toBe(mode !== "plan");
    } finally {
      delivered.mockRestore();
      browsed.length = 0;
      core.runs.close(run.id);
    }
  });

  it("stops a chain of agent messages until a person writes", async () => {
    const [first, second] = ["Ping", "Pong"].map((title) => threads.insert(core.db, { projectId: project.id, title, agent: "codex", model: "fixture", mode: "act", permissionMode: "autonomous" }));
    const delivered = vi.spyOn(core.threads, "send").mockResolvedValue();
    const p = provider("codex");
    const run = await core.runs.start({ scope: { thread: first!, task: null }, project, agent: "codex", model: "fixture", mode: "act", permissionMode: "autonomous", prompt: "Start", resume: false });
    try {
      await vi.waitFor(() => expect(p.ready()).toBe(true));
      const url = (await core.mcpServer()).urlForRun(run.id);
      // Each delivered message makes the receiver one hop deeper; here the sender plays both ends of the chain.
      for (let hop = 1; hop <= MAX_AGENT_HOPS; hop++) {
        core.runs.noteAgentMessage(first!.id, hop - 1);
        expect(JSON.parse((await toolCall(url, "thread_send", { id: second!.id, text: `Message ${hop}` })).text).delivered).toBe(true);
      }
      core.runs.noteAgentMessage(first!.id, MAX_AGENT_HOPS);
      expect(JSON.parse((await toolCall(url, "thread_send", { id: second!.id, text: "One too many" })).text)).toMatchObject({
        delivered: false,
        message: expect.stringMatching(new RegExp(`limit is ${MAX_AGENT_HOPS}`)),
      });
      // The same retried call is delivered once.
      core.runs.noteAgentMessage(first!.id, 0);
      await toolCall(url, "thread_send", { id: second!.id, text: "Once", request_key: "retry" });
      await toolCall(url, "thread_send", { id: second!.id, text: "Once", request_key: "retry" });
      expect(delivered.mock.calls.filter(([, text]) => text === "Once")).toHaveLength(1);
    } finally {
      delivered.mockRestore();
      core.runs.close(run.id);
    }
  });

  it("keeps what the user wrote in memory from agents", async () => {
    const thread = threads.insert(core.db, { projectId: project.id, title: "Memory guard", agent: "codex", model: "fixture", mode: "act", permissionMode: "autonomous" });
    const mine = memories.upsert(core.db, { projectId: project.id, type: "convention", topicKey: "style/quotes", title: "Use double quotes", body: "The user decided.", source: "user" }).memory;
    const p = provider("codex");
    const run = await core.runs.start({ scope: { thread, task: null }, project, agent: "codex", model: "fixture", mode: "act", permissionMode: "autonomous", prompt: "Remember", resume: false });
    try {
      await vi.waitFor(() => expect(p.ready()).toBe(true));
      const url = (await core.mcpServer()).urlForRun(run.id);
      expect((await toolCall(url, "memory_record", { type: "convention", title: "Use single quotes", body: "An agent disagrees.", topic_key: "style/quotes" })).text).toMatch(
        /only the user can change it/,
      );
      expect((await toolCall(url, "memory_feedback", { id: mine.id, verdict: "wrong" })).text).toMatch(/Only the user can retract/);
      expect((await toolCall(url, "memory_record", { type: "lesson", title: "x".repeat(121), body: "Too long a title." })).isError).toBe(true);
      expect(memories.get(core.db, mine.id)).toMatchObject({ title: "Use double quotes", status: "active" });
    } finally {
      core.runs.close(run.id);
    }
  });
});

// Closes the core, so it runs last.
it("settles all MCP questions during app shutdown and rejects calls on the old run URL", async () => {
  const thread = threads.insert(core.db, { projectId: project.id, title: "Shutdown questions", agent: "opencode", model: "fixture", mode: "act", permissionMode: "autonomous" });
  const p = provider("opencode");
  const run = await core.runs.start({ scope: { thread, task: null }, project, agent: "opencode", model: "fixture", mode: "act", permissionMode: "autonomous", prompt: "Ask", resume: false });
  await vi.waitFor(() => expect(p.ready()).toBe(true));
  const url = (await core.mcpServer()).urlForRun(run.id);
  const input = { questions: [{ id: "note", question: "Any notes?" }] };
  const results = [mcpCall(url, "ask_user", input), mcpCall(url, "ask_user", input)];
  await vi.waitFor(() => expect(core.runs.pending().filter((a) => a.runId === run.id)).toHaveLength(2));
  await core.runs.closeAll();
  expect(await Promise.all(results)).toEqual([expect.objectContaining({ status: "cancelled" }), expect.objectContaining({ status: "cancelled" })]);
  expect(core.runs.pending()).toEqual([]);
  await expect(mcpCall(url, "ask_user", input)).rejects.toThrow("HTTP 404: unknown run");
  await vi.waitFor(() => expect(questionEvents(run.id).filter((e) => e.type === "approval.resolved")).toHaveLength(2));
});

function consentProtocolResponse(method: string, agent: string) {
  if (method === "config/read") return { config: { mcp_servers: {} } };
  if (method === "thread/start") return { thread: { id: "consent-session" } };
  if (method === "initialize" && agent === "opencode") return { protocolVersion: 1, agentCapabilities: {} };
  if (method === "session/new") return { sessionId: "consent-session" };
  if (method === "session/set_config_option") return { configOptions: [] };
  return {};
}
function expectedToolDecision(external: boolean, sameServer: boolean) {
  if (external) return { decision: "decline" };
  if (!sameServer) return { action: "decline" };
  return { action: "accept" };
}
function expectedPermissionMode(mode: string, permissionMode: string) {
  if (mode === "plan") return "plan";
  if (permissionMode === "trusted") return "acceptEdits";
  return "default";
}
