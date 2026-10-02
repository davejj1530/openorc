import { spawnAgentProcess } from "../process-recovery.js";
import { fileBoundaryHook } from "./file-boundary.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stopProcess, waitForProcessGroup } from "../process-lifetime.js";
import readline from "node:readline";
import { ULTRACODE_EFFORT, type AgentEvent, type FileBoundary, type RunSpec } from "@openorc/protocol";
import { ClaudeStreamParser } from "./stream-json.js";
import { claudeConfigDir } from "./config-dir.js";
import { RunHandle, type RunControls } from "../run-handle.js";
import { withAttachedFiles } from "../attachments.js";
import type { AgentLaunchEnvironment } from "../launch-environment.js";
import { stripAnsi } from "../jsonrpc.js";

export interface ClaudeAdapterOptions {
  /** Path or name of the Claude Code binary. Never modified, never bundled. */
  binary?: string;
  /** Extra environment. The adapter strips the nested-session guard by default. */
  env?: NodeJS.ProcessEnv;
  /** Name of the MCP server in --mcp-config; the approval tool must live on it. */
  mcpServerName?: string;
  /** Only load the servers we pass. Keeps user config out of spikes. */
  strictMcp?: boolean;
  /** How long to wait for the CLI to start a turn on its own, after a steered turn's result or after background work ends. Tests shorten it. */
  followUpGraceMs?: number;
  /** How long a live settings request waits for its matching response. Tests shorten it. */
  controlReplyTimeoutMs?: number;
}

/** Claude Code takes no attachment flag in print mode; its Read tool opens an image or a document when told where it lives. */
export function withAttachments(prompt: string, attachments: string[] | undefined): string {
  return withAttachedFiles(prompt, attachments ?? [], "open with the Read tool");
}

/** One line of Claude Code's stream-json input: a user turn, or a mid-turn message when a turn is running. */
export function userMessageLine(text: string, attachments?: string[]): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: withAttachments(text, attachments) }] }, parent_tool_use_id: null, session_id: "" });
}

/**
 * Ultracode only differs from xhigh when the session can run the Workflow tool.
 * Claude Code drops that tool silently (workflows off in its settings, or a
 * `--tools` list that leaves it out), so the app says so once per session.
 * Returns the notice to post, or null when ultracode is not requested or the
 * session lists the tool.
 */
export function ultracodeFallbackNotice(spec: Pick<RunSpec, "effort" | "mode" | "permissionMode">, tools: readonly string[] | undefined): string | null {
  if (spec.effort !== ULTRACODE_EFFORT || !tools || tools.includes("Workflow")) return null;
  if (spec.mode === "plan") return "Ultracode is running at Extra high while planning. Workflows start once the plan is implemented in Autonomous mode.";
  if (spec.permissionMode !== "autonomous") return "Ultracode is running at Extra high. Workflows need Autonomous permissions; switch the mode to let it orchestrate.";
  return "Ultracode is running at Extra high. Claude Code did not offer workflows to this session; enable them in its settings or check your plan.";
}

/** Where the CLI keeps plan files when no project-relative plansDirectory is configured. */
function claudePlansDirectory(env: NodeJS.ProcessEnv): string {
  return path.join(claudeConfigDir(os.homedir(), env), "plans");
}

const permissionModeFor: Record<RunSpec["permissionMode"], string> = {
  review: "default",
  trusted: "acceptEdits",
  autonomous: "bypassPermissions",
};

/** How long an idle process gets to exit on its own after its input closes before it is stopped. */
const IDLE_EXIT_GRACE_MS = 2000;
/**
 * The CLI starts some turns on its own, right after something else ends, and
 * announces neither in advance:
 * - A message written during a turn is either taken at the next tool boundary or,
 *   when none is left, started as its own turn right after the result. The result
 *   of a steered turn is held this long: an init in that window is the same turn
 *   carrying on, not a new one.
 * - Background work that finishes brings the agent back to report on it. The end
 *   of that work is held this long, so the session never reads as idle in between.
 */
const FOLLOW_UP_GRACE_MS = 750;
/** How long a settings change waits for the CLI's answer before the caller gives up and restarts. */
const CONTROL_REPLY_TIMEOUT_MS = 10_000;

/** One control request line. Claude Code answers each with a control_response carrying the same id. */
function controlRequest(request: Record<string, unknown>, requestId = randomUUID()): string {
  return JSON.stringify({ type: "control_request", request_id: requestId, request });
}

function controlFailure(response: Record<string, unknown> | undefined): Error | undefined {
  if (response?.["subtype"] !== "error") return undefined;
  if (typeof response["error"] === "string") return new Error(response["error"]);
  return new Error("Claude Code rejected the settings change.");
}

/** Plan restrictions take precedence over the session's ordinary permission mode. */
function launchPermissionSettings(spec: RunSpec, plans: string | null, connection: { mcpUrl: string; dir: string } | null) {
  const boundaryHook = (matcher: string, boundary: FileBoundary) => ({
    PreToolUse: [{ matcher, hooks: [{ type: "command", command: fileBoundaryHook(boundary, connection) }] }],
  });
  if (plans) {
    return {
      permissions: { deny: ["Bash", "NotebookEdit", "Agent", "Task"] },
      hooks: boundaryHook("Edit|Write", { root: plans, cwd: spec.cwd, outside: "deny" }),
    };
  }
  if (spec.permissionMode === "autonomous") return {};
  return {
    permissions: { ask: spec.permissionMode === "review" ? ["Bash", "Edit", "Write", "NotebookEdit"] : ["Bash"], deny: ["Agent", "Task"] },
    sandbox: { autoAllowBashIfSandboxed: false },
    ...(spec.permissionMode === "trusted" ? { hooks: boundaryHook("Edit|Write|NotebookEdit", { root: spec.cwd, cwd: spec.cwd, outside: "ask" }) } : {}),
  };
}

/**
 * Spawns the unmodified `claude` binary in print mode with stream-json input
 * and keeps it open for the life of the run: every user message is one line on
 * stdin, so follow-ups reuse the process and a message during a turn reaches
 * the model at its next tool boundary. When the turn ends first, the CLI runs
 * the message straight after; that continuation is reported as the same turn.
 * Background work the agent starts can outlive its turn: the adapter reports
 * how much is running, and a stop between turns ends it.
 *
 * Auth is the user's own login inside the CLI; this adapter never reads or
 * forwards credentials, and never uses `--bare` (which would ignore them).
 */
export class ClaudeAdapter {
  constructor(private readonly options: ClaudeAdapterOptions = {}) {}

  start(spec: RunSpec, launch: AgentLaunchEnvironment): RunHandle {
    return startClaudeSession(spec, prepareClaudeLaunch(spec, launch, this.options), this.options);
  }
}

/**
 * Settings and MCP servers stay the ones OpenOrc chooses: only its own server while tools are restricted or the user
 * asked for that, and only the user's own settings in an unvetted checkout. -p skips Claude Code's workspace trust
 * check, so that checkout's settings, hooks and MCP servers would otherwise apply. Settings passed with --settings still do.
 */
function isolationArgs(spec: RunSpec, restricted: boolean, strictMcp: boolean): string[] {
  const untrusted = spec.untrustedCheckout === true;
  return [...(untrusted ? ["--setting-sources", "user"] : []), ...(restricted || strictMcp || untrusted ? ["--strict-mcp-config"] : [])];
}

/** Prepare the exact CLI launch and private MCP file before a process owns them. */
function prepareClaudeLaunch(spec: RunSpec, launch: AgentLaunchEnvironment, options: ClaudeAdapterOptions) {
  if (process.platform === "win32" && (spec.mode === "plan" || spec.permissionMode === "trusted"))
    throw new Error("This mode requires a file-boundary hook that is not yet supported on Windows. Choose Review everything.");
  const binary = launch.binary;
  const env: NodeJS.ProcessEnv = { ...launch.env, ...options.env };
  // Claude Code refuses to nest inside itself; the app is not a Claude session.
  delete env["CLAUDECODE"];
  // Claude keeps plan files in its own plans directory, as in its desktop app. The
  // CLI ignores a plansDirectory outside the project, so the boundary follows it instead.
  const plans = spec.mode === "plan" ? claudePlansDirectory(env) : null;
  if (plans) mkdirSync(plans, { recursive: true });
  const serverName = spec.internalMcp?.serverName ?? options.mcpServerName ?? "openorc";
  const mcpUrl = spec.internalMcp?.url ?? spec.mcpUrl;
  // OpenOrc's address carries a secret, so it reaches the CLI in files only this user can read, never in argv.
  const connection = mcpUrl ? { mcpUrl, dir: mkdtempSync(path.join(os.tmpdir(), "openorc-claude-")) } : null;
  try {
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      // Scope the preference to this process, including explicit Standard on resume.
      "--settings",
      JSON.stringify({
        fastMode: Boolean(spec.fastMode),
        ...launchPermissionSettings(spec, plans, connection),
      }),
      "--permission-mode",
      spec.mode === "plan" ? "plan" : permissionModeFor[spec.permissionMode],
    ];
    const restricted = spec.mode === "plan" || spec.permissionMode !== "autonomous";
    // Restrict mutation entry points to the tools covered by our explicit rules.
    // Native subagents have independent policies; use OpenOrc's inherited-policy delegation instead.
    if (restricted) args.push("--tools", "Read,Grep,Glob,Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,AskUserQuestion,ExitPlanMode");
    args.push(...isolationArgs(spec, restricted, Boolean(connection) && (spec.strictMcp ?? options.strictMcp) === true));
    if (spec.model) args.push("--model", spec.model);
    if (spec.effort) args.push("--effort", spec.effort);
    if (spec.maxTurns) args.push("--max-turns", String(spec.maxTurns));
    if (spec.resumeSessionId) {
      args.push("--resume", spec.resumeSessionId);
      // A fork continues the transcript under a new session id, so the original keeps its own history.
      if (spec.forkSession) args.push("--fork-session");
    } else args.push("--session-id", spec.runId);
    if (spec.systemPromptAppendix || spec.mode === "plan")
      args.push(
        "--append-system-prompt",
        [
          spec.systemPromptAppendix,
          spec.mode === "plan"
            ? "Write the proposed plan to your plan file, then call ExitPlanMode to present it. OpenOrc shows it to the user, who implements it from OpenOrc or replies with changes. Only the plan file may be written; shell tools are disabled while planning. Use Read, Grep and Glob to investigate."
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
    if (connection) {
      const configFile = path.join(connection.dir, "mcp.json");
      writeFileSync(configFile, JSON.stringify({ mcpServers: { [serverName]: { type: "http", url: connection.mcpUrl } } }), { mode: 0o600 });
      args.push("--mcp-config", configFile);
      // --mcp-config makes the first turn wait for all of the user's MCP servers, slow remote connectors included.
      // Claude Code still waits for the server behind --permission-prompt-tool, so ours is ready; the rest connect in the background.
      env["CLAUDE_CODE_MCP_STARTUP_WAIT_MS"] ??= "0";
      args.push("--permission-prompt-tool", `mcp__${serverName}__approve`);
      // Exact tools on this app-owned connection, never a global tool-name rule.
      if (spec.internalMcp) args.push("--allowedTools", ...spec.internalMcp.toolNames.map((name) => `mcp__${serverName}__${name}`));
    }

    return { binary, env, args, connection, registry: launch.processRegistry };
  } catch (error) {
    // Preparation owns the private directory until the process lifetime takes it over.
    if (connection) rmSync(connection.dir, { recursive: true, force: true });
    throw error;
  }
}

type BackgroundUpdated = Extract<AgentEvent, { type: "background.updated" }>;

/**
 * Background work that ends between turns is held until the CLI shows whether the agent comes back to report on it,
 * so the session never reads as idle in between. Commands coming and going are never held.
 */
class BackgroundSettling {
  private held: { event: BackgroundUpdated; timer: ReturnType<typeof setTimeout> } | null = null;
  /** How much background work the host last heard of. */
  private reportedWork = 0;

  constructor(
    private readonly emit: (event: BackgroundUpdated) => void,
    private readonly graceMs: number,
  ) {}

  /** A newer list replaces one still held. */
  update(event: BackgroundUpdated, activeTurn: boolean): void {
    this.drop();
    if (event.running === 0 && this.reportedWork > 0 && !activeTurn) {
      this.held = { event, timer: setTimeout(() => this.release(), this.graceMs) };
      return;
    }
    this.reportedWork = event.running;
    this.emit(event);
  }

  /** A turn took over, or no turn came: the end of the work can be reported. */
  release(): void {
    const held = this.held;
    if (!held) return;
    this.drop();
    this.reportedWork = held.event.running;
    this.emit(held.event);
  }

  drop(): void {
    if (this.held) clearTimeout(this.held.timer);
    this.held = null;
  }
}

/** One session owns the child, pending writers and controls until the close barrier settles. */
function startClaudeSession(spec: RunSpec, prepared: ReturnType<typeof prepareClaudeLaunch>, options: ClaudeAdapterOptions): RunHandle {
  const { binary, env, args, connection, registry } = prepared;
  const startedAt = Date.now();
  let handle: RunHandle;
  let proc: ChildProcessWithoutNullStreams;
  try {
    proc = spawnAgentProcess(binary, args, { cwd: spec.cwd, env, registry });
  } catch (error) {
    if (connection) rmSync(connection.dir, { recursive: true, force: true });
    throw error;
  }
  const parser = new ClaudeStreamParser(spec.runId, { fastMode: spec.fastMode });
  /** A user message was written and its result has not arrived. Queued input starts turns too, so init lines set it as well. */
  let activeTurn = false;
  /** The next result ends a turn the user stopped, not one that failed. */
  let interrupting = false;
  /** Input is closed so an idle process can exit on its own. */
  let ending = false;
  /** A /compact the app asked for, settled by the compaction activity the stream reports. */
  let compaction: { resolve: () => void; reject: (error: Error) => void; promise: Promise<void> } | null = null;
  /** Messages written while a turn was running that no result has accounted for yet. */
  let midTurnWrites = 0;
  /** A steered turn's result, held until the CLI shows whether it carries on with the queued input. */
  let held: { event: Extract<AgentEvent, { type: "turn.completed" }>; timer: ReturnType<typeof setTimeout> } | null = null;
  /** Time of results folded into a turn that carried on. Cost needs no carrying: every result reports the session's running total. */
  let carriedMs = 0;
  const background = new BackgroundSettling((event) => handle.emit("event", event), options.followUpGraceMs ?? FOLLOW_UP_GRACE_MS);
  /** Control requests whose answer decides something, by request id. Stops and interrupts are not awaited. */
  const controlReplies = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const exited = () => proc.exitCode !== null || proc.signalCode !== null;
  // A closed pipe must never throw into the host; the exit path reports what happened.
  proc.stdin.on("error", () => undefined);
  const write = (line: string): Promise<void> =>
    new Promise((resolve, reject) => {
      if (ending || exited() || proc.stdin.destroyed) {
        reject(new Error("The Claude process is no longer accepting input."));
        return;
      }
      proc.stdin.write(`${line}\n`, (error) => (error ? reject(error) : resolve()));
    });
  /** One user line, remembered as mid-turn input when a turn is running. */
  const writeUser = async (text: string, attachments?: string[]): Promise<void> => {
    const midTurn = activeTurn;
    await write(userMessageLine(text, attachments));
    if (midTurn) midTurnWrites += 1;
  };
  const completeTurn = (ev: Extract<AgentEvent, { type: "turn.completed" }>): void => {
    activeTurn = false;
    midTurnWrites = 0;
    if (carriedMs) {
      ev = { ...ev, durationMs: ev.durationMs + carriedMs };
      carriedMs = 0;
    }
    handle.emit("event", ev);
  };
  /** The window closed with no continuation: the turn really is over. */
  const releaseHeld = (): void => {
    if (!held) return;
    const { event, timer } = held;
    held = null;
    clearTimeout(timer);
    completeTurn(event);
  };
  /** The agent came back, or the window closed without it: the end of the background work can be reported. */
  const settleControl = (requestId: string, error?: Error): void => {
    const pending = controlReplies.get(requestId);
    if (!pending) return;
    controlReplies.delete(requestId);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve();
  };
  /** A control request answered by the CLI: success resolves, an error or silence rejects. */
  const control = (request: Record<string, unknown>): Promise<void> =>
    new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => settleControl(requestId, new Error("Claude Code did not answer the settings change.")), options.controlReplyTimeoutMs ?? CONTROL_REPLY_TIMEOUT_MS);
      timer.unref();
      controlReplies.set(requestId, { resolve, reject, timer });
      write(controlRequest(request, requestId)).catch((error: unknown) => settleControl(requestId, error instanceof Error ? error : new Error(String(error))));
    });
  const controlResponse = (payload: Record<string, unknown>): void => {
    if (payload["type"] !== "control_response") return;
    const response = payload["response"] as Record<string, unknown> | undefined;
    const requestId = response?.["request_id"];
    if (typeof requestId !== "string") return;
    const failure = controlFailure(response);
    settleControl(requestId, failure);
  };
  /** Close all child resources before reporting the final session event. */
  const finalizeProcess = async (code: number | null): Promise<void> => {
    await waitForProcessGroup(proc);
    if (connection) rmSync(connection.dir, { recursive: true, force: true });
    releaseHeld();
    // The process is gone, and its background work with it.
    background.drop();
    compaction?.reject(new Error("Claude exited before context compaction finished."));
    for (const requestId of [...controlReplies.keys()]) settleControl(requestId, new Error("Claude exited before answering the settings change."));
    compaction = null;
    handle.emit("event", {
      type: "session.completed",
      runId: spec.runId,
      ts: Date.now(),
      status: code === 0 || (code === null && ending) ? "success" : "error",
      durationMs: Date.now() - startedAt,
      turns: parser.turns,
    });
    handle.emit("exit", code);
  };
  const done = new Promise<number | null>((resolve) => {
    proc.on("close", async (code) => {
      await finalizeProcess(code);
      resolve(code);
    });
  });
  proc.once("exit", () => {
    try {
      stopProcess(proc);
    } catch (error) {
      // Natural wrapper exit is an asynchronous callback. Keep the physical
      // group barrier pending and report cleanup trouble without crashing.
      handle.emit("event", { type: "error", runId: spec.runId, ts: Date.now(), message: `Process cleanup needs attention: ${error instanceof Error ? error.message : String(error)}`, fatal: false });
    }
  });

  /** The public handle only forwards to this session's live controls. */
  const liveControls = (done: Promise<number | null>): RunControls => ({
    interrupt: () => {
      // A held result means the turn already ended; nothing is running to stop.
      if (held) {
        releaseHeld();
        return;
      }
      if (exited()) return;
      if (!activeTurn) {
        // Between turns, what still works is background work the agent started. Stopping it starts no turn. Commands,
        // such as a dev server, are not the agent at work; each has its own stop.
        for (const taskId of parser.backgroundWork) void write(controlRequest({ subtype: "stop_task", task_id: taskId })).catch(() => undefined);
        return;
      }
      interrupting = true;
      // The control channel stops the turn and keeps the session usable; a dead pipe falls back to the signal.
      void write(controlRequest({ subtype: "interrupt" })).catch(() => proc.kill("SIGINT"));
    },
    close: () => {
      if (exited()) {
        stopProcess(proc);
        return;
      }
      if (activeTurn || ending) {
        stopProcess(proc);
        return;
      }
      // Between turns the process is waiting for input; closing it lets the CLI exit cleanly.
      ending = true;
      proc.stdin.end();
      const timer = setTimeout(() => {
        if (!exited()) stopProcess(proc);
      }, IDLE_EXIT_GRACE_MS);
      timer.unref();
      proc.once("close", () => clearTimeout(timer));
    },
    send: async (text, attachments) => {
      await writeUser(text, attachments);
      activeTurn = true;
    },
    stopCommand: async (commandId) => {
      // One that already ended has nothing to stop. A stop the user asked for starts no turn.
      if (exited() || !parser.backgroundCommands.some((command) => command.id === commandId)) return;
      await write(controlRequest({ subtype: "stop_task", task_id: commandId }));
    },
    // set_model and the effortLevel and fastMode flags take effect on the next turn of the same session; the flags land in
    // the layer --settings filled at launch. The CLI answers each request.
    applySettings: async ({ model, effort, fastMode }) => {
      if (activeTurn || held) throw new Error("Wait for the current turn to finish before changing its settings.");
      if (compaction) throw new Error("Wait for context compaction to finish before changing settings.");
      if (ending || exited()) throw new Error("The Claude process is no longer running.");
      if (model !== undefined) await control({ subtype: "set_model", model });
      if (effort !== undefined) await control({ subtype: "apply_flag_settings", settings: { effortLevel: effort } });
      if (fastMode !== undefined) {
        await control({ subtype: "apply_flag_settings", settings: { fastMode } });
        parser.expectFastMode(fastMode);
      }
    },
    compacting: () => Boolean(compaction),
    canSteer: () => activeTurn && !held && !compaction && !ending && !exited(),
    steer: async (text, attachments) => {
      if (!activeTurn || held || compaction || ending || exited()) return "unavailable";
      await writeUser(text, attachments);
      return "accepted";
    },
    // Claude Code's own /compact folds the session in place; the stream reports the compacting status and its boundary.
    compact: async () => {
      if (compaction) return compaction.promise;
      if (activeTurn) throw new Error("Wait for the current turn to finish before compacting.");
      if (ending || exited()) throw new Error("The Claude process is no longer running.");
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      void promise.catch(() => {});
      compaction = { resolve, reject, promise };
      parser.expectManualCompaction();
      try {
        await write(userMessageLine("/compact"));
      } catch (error) {
        compaction = null;
        throw error;
      }
      return promise;
    },
    done,
  });
  handle = new RunHandle(spec.runId, liveControls(done));

  /** Stream events settle controls and turn/background windows before emission. */
  const routeEvent = (ev: AgentEvent): void => {
    if (ev.type === "raw") controlResponse(ev.payload as Record<string, unknown>);
    if (ev.type === "activity.updated" && ev.activityId.startsWith("compaction-") && ev.status !== "running" && compaction) {
      const pending = compaction;
      compaction = null;
      if (ev.status === "success") pending.resolve();
      else pending.reject(new Error(ev.text ?? "Context compaction failed."));
    }
    if (ev.type === "session.started") {
      handle.emit("event", ev);
      const notice = ultracodeFallbackNotice(spec, ev.tools);
      if (notice) handle.emit("event", { type: "message.completed", runId: spec.runId, ts: Date.now(), messageId: `ultracode-${spec.runId}`, role: "system", text: notice });
      return;
    }
    if (ev.type === "turn.started") {
      activeTurn = true;
      if (held) {
        // The CLI took the mid-turn input as its own turn: the steered turn carries on.
        clearTimeout(held.timer);
        carriedMs += held.event.durationMs;
        held = null;
        midTurnWrites = 0;
      } else handle.emit("event", ev);
      // Background work that just ended hands over to this turn, so the session never reads as idle.
      background.release();
      return;
    }
    if (ev.type === "turn.completed") {
      if (interrupting) {
        interrupting = false;
        completeTurn(ev.status === "success" ? ev : { ...ev, status: "cancelled" });
        return;
      }
      if (midTurnWrites > 0) {
        held = { event: ev, timer: setTimeout(releaseHeld, options.followUpGraceMs ?? FOLLOW_UP_GRACE_MS) };
        return;
      }
      completeTurn(ev);
      return;
    }
    if (ev.type === "background.updated") {
      background.update(ev, activeTurn);
      return;
    }
    handle.emit("event", ev);
  };
  const out = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
  out.on("line", (line) => {
    for (const ev of parser.parseLine(line)) routeEvent(ev);
  });
  const err = readline.createInterface({ input: proc.stderr, crlfDelay: Infinity });
  err.on("line", (line) => {
    handle.emit("event", { type: "error", runId: spec.runId, ts: Date.now(), message: stripAnsi(line), fatal: false });
  });
  proc.on("error", (e) => {
    handle.emit("event", { type: "error", runId: spec.runId, ts: Date.now(), message: e.message, fatal: true });
    // A binary that could not be spawned never exits; end the run here so it does not stay live forever.
    if (!proc.pid) proc.emit("exit", null, null);
  });

  // The first turn is the prompt. A process that cannot take it reports through its exit.
  activeTurn = true;
  void write(userMessageLine(spec.prompt, spec.attachments)).catch(() => {
    activeTurn = false;
  });

  return handle;
}
