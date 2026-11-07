import type { AgentEvent, BackgroundCommand, Usage } from "@openorc/protocol";
import { claudeFastModeReason } from "./fast-mode.js";
import { ClaudeWorkflows } from "./workflows.js";
import { ClaudeSubagents } from "./subagents.js";
import { isRecord, num, sessionId, str } from "./stream-values.js";

/**
 * Background tasks that are the agent's own work, which report back when they finish. Anything else Claude Code runs
 * in the background, such as a shell command or a monitor, is a command that runs until it ends or is stopped.
 */
const BACKGROUND_WORK = new Set(["local_agent", "remote_agent", "local_workflow", "in_process_teammate"]);

/** Logins that come from a key the user set rather than their account. Signing in again does not replace them. */
const USER_KEY_SOURCES = new Set(["ANTHROPIC_API_KEY", "apiKeyHelper"]);

function sameCommands(a: readonly BackgroundCommand[], b: readonly BackgroundCommand[]): boolean {
  return a.length === b.length && a.every((command, i) => command.id === b[i]!.id && command.description === b[i]!.description);
}

/** An explicit provider error wins over the result subtype. */
function resultStatus(isError: boolean, subtype: string): "error" | "max_turns" | "success" {
  if (isError) return "error";
  if (subtype === "error_max_turns") return "max_turns";
  if (subtype === "success") return "success";
  return "error";
}

function backgroundStatus(finished: boolean, failed: boolean): "running" | "error" | "success" {
  if (!finished) return "running";
  return failed ? "error" : "success";
}

/**
 * Maps Claude Code's `--output-format stream-json` lines onto AgentEvents.
 * One process answers many prompts, each opened by an init line and closed by
 * a result line. Besides messages and tools, the stream carries what Claude
 * Code is doing between them: waiting for the API, thinking, running a
 * background task, compacting. Those become activity, thinking and tool
 * progress events so the app can show them the way Claude Code's own UI does.
 *
 * Anthropic has not published a complete type reference for this stream, so
 * the parser keeps unfamiliar, well-formed events as `raw`. Malformed records
 * produce a nonfatal error so the next line can still be processed.
 */
export interface ClaudeTranscriptTarget {
  kind: "workflow" | "agent";
  agentId: string;
  subagentId: string;
  finished: boolean;
}

export class ClaudeStreamParser {
  private readonly childRecords = new Set<string>();
  readonly workflows: ClaudeWorkflows;
  private readonly subagents: ClaudeSubagents;
  private currentMessageId: string | null = null;
  private readonly toolNames = new Map<string, string>();
  private readonly toolParents = new Map<string, string>();
  /** Tools announced from a streamed content block, before their input finished; the assistant line then updates them. */
  private readonly toolsStarted = new Set<string>();
  private childInputs = 0;
  /** Where each task this process started shows: on a row of its own, or elsewhere (a tool row, or the call that started the subagent running it). */
  private readonly taskPlaces = new Map<string, "own" | "elsewhere">();
  /** The model the session runs on, from the init line; picks its entry out of a result's per-model usage. */
  private model: string | null = null;
  /** Where the session's login comes from, from the init line. */
  private keySource: string | null = null;
  /** Model turns summed over every result line; read when the process exits. */
  turns = 0;
  /** The init line repeats at every turn of a stream-json process; the session is announced once. */
  private announced = false;
  private starts = 0;
  /** The open "waiting for the API" activity, one per request. */
  private requesting: string | null = null;
  private requests = 0;
  /** The thinking block in progress, keyed by its message; `index` is its content block when streamed. */
  private thinking: { messageId: string; index: number | null } | null = null;
  /** Context compaction in progress, from the compacting status to its boundary. */
  private compaction: { id: string; manual: boolean } | null = null;
  private compactions = 0;
  private manualCompactionRequested = false;
  /** A manual compaction ends with an empty result line that is not a turn. */
  private swallowEmptyResult = false;
  /** Whether the session currently asks for Fast, so its state lines are worth a notice. */
  private fastMode: boolean;
  /** The last Fast state reported for a run that asked for Fast, with its reason when off. */
  private fastModeState: string | null = null;
  private fastModeNotices = 0;
  /** What the session has running in the background: its work by id, and its commands. */
  private background: { work: string[]; commands: BackgroundCommand[] } = { work: [], commands: [] };

  constructor(
    private readonly runId: string,
    options: { fastMode?: boolean; resumedSubagents?: import("@openorc/protocol").RunSpec["resumedSubagents"] } = {},
  ) {
    this.fastMode = Boolean(options.fastMode);
    this.subagents = new ClaudeSubagents(runId);
    this.subagents.restore(options.resumedSubagents ?? []);
    this.workflows = new ClaudeWorkflows(runId);
  }

  /** The session's Fast preference changed in place: the next state line is reported as the first of the new preference. */
  expectFastMode(fastMode: boolean): void {
    this.fastMode = fastMode;
    this.fastModeState = null;
  }

  /** The next compaction was asked for by the app, not started by the CLI on its own. */
  expectManualCompaction(): void {
    this.manualCompactionRequested = true;
  }

  /** Background work the session has running, such as a subagent, by id, so a stop can end it. */
  get backgroundWork(): readonly string[] {
    return this.background.work;
  }

  /** Commands the session has running in the background, such as a dev server, so each can be stopped on its own. */
  get backgroundCommands(): readonly BackgroundCommand[] {
    return this.background.commands;
  }

  subagentTaskId(nativeId: string): string | null {
    return this.workflows.taskId(nativeId) ?? this.subagents.taskId(nativeId);
  }

  stoppedSubagents(nativeId?: string): AgentEvent[] {
    return this.subagents.stopped(nativeId);
  }

  workflowMessage(agentId: string, message: Record<string, unknown>, ts: number): AgentEvent[] {
    const out: AgentEvent[] = [];
    const normalized = this.workflows.message(agentId, message, ts, out);
    if (normalized) out.push(...this.parseLine(JSON.stringify(normalized), ts, "file"));
    return out;
  }

  transcriptTargets(): ClaudeTranscriptTarget[] {
    return [
      ...this.workflows.targets().map((target): ClaudeTranscriptTarget => ({ ...target, kind: "workflow" })),
      ...this.subagents.transcriptTargets().map((target): ClaudeTranscriptTarget => ({ ...target, kind: "agent" })),
    ];
  }

  transcriptMessage(target: ClaudeTranscriptTarget, message: Record<string, unknown>, ts: number): AgentEvent[] {
    if (target.kind === "workflow") return this.workflowMessage(target.agentId, message, ts);
    const out: AgentEvent[] = [];
    const normalized = this.subagents.transcriptMessage(target.agentId, message, ts, out);
    if (normalized) out.push(...this.parseLine(JSON.stringify(normalized), ts, "file"));
    return out;
  }

  parseLine(line: string, now = Date.now(), source: "stream" | "file" = "stream"): AgentEvent[] {
    const decoded = decodeStreamLine(line, this.runId, now);
    if (decoded.kind === "events") return decoded.events;
    const msg = decoded.message;
    this.workflows.observeSession(msg);
    const out: AgentEvent[] = [{ type: "raw", runId: this.runId, ts: now, agent: "claude", payload: msg }];
    if (this.heartbeat(msg, now, out)) return out;
    const child = this.childLine(msg, now, out, source);
    if (child) return child;
    switch (msg["type"]) {
      case "system":
        this.system(msg, now, out);
        break;
      case "stream_event":
        this.streamEvent(msg, now, out);
        break;
      case "assistant":
        if (this.accountSignedOut(msg)) this.signInNeeded(msg, now, out);
        else this.assistant(msg, now, out);
        break;
      case "user":
        this.user(msg, now, out);
        break;
      case "tool_progress":
        this.toolProgress(msg, now, out);
        break;
      case "rate_limit_event":
        this.rateLimit(msg, now, out);
        break;
      case "result":
        this.result(msg, now, out);
        break;
    }
    return out;
  }

  private childLine(msg: Record<string, unknown>, now: number, out: AgentEvent[], source: "stream" | "file"): AgentEvent[] | null {
    const rawParent = str(msg["parent_tool_use_id"]);
    const parent = rawParent ? this.subagents.identity(rawParent) : null;
    if (parent) {
      this.subagents.forkedCommand(parent, str(msg["agent_id"]), now, out);
      if (msg["type"] === "tool_progress" && !this.subagents.known(parent)) return null;
      if (!this.subagents.accepts(parent, msg)) return out;
      msg = { ...msg, parent_tool_use_id: parent };
      if (source === "stream" && (msg["type"] === "assistant" || msg["type"] === "user")) this.subagents.observe(parent);
      const unique = this.childRecord(parent, msg);
      if (!unique) return out;
      msg = unique;
      if (msg["type"] === "assistant") this.assistant(msg, now, out);
      else if (msg["type"] === "user") this.user(msg, now, out);
      else if (msg["type"] === "tool_progress") this.toolProgress(msg, now, out);
      else if (msg["type"] === "system") this.workflows.task(msg, now, out);
      return out.map((event) => (event.type === "raw" || event.type === "subagent.started" || event.type === "subagent.updated" ? event : { ...event, subagentId: parent }));
    }
    return null;
  }

  private childRecord(parent: string, msg: Record<string, unknown>): Record<string, unknown> | null {
    const uuid = str(msg["uuid"]);
    if (!uuid || (msg["type"] !== "assistant" && msg["type"] !== "user")) return msg;
    const id = `subagent:${parent}:${uuid}`;
    if (this.childRecords.has(id)) return null;
    this.childRecords.add(id);
    return isRecord(msg["message"]) ? { ...msg, message: { ...msg["message"], id } } : msg;
  }

  private heartbeat(msg: Record<string, unknown>, now: number, out: AgentEvent[]): boolean {
    if (msg["type"] !== "tool_progress" || msg["heartbeat"] !== true) return false;
    const toolCallId = str(msg["parent_tool_use_id"]);
    if (!toolCallId) return true;
    this.toolProgress({ ...msg, tool_use_id: toolCallId }, now, out);
    const parent = this.toolParents.get(toolCallId);
    if (parent) for (const event of out) if (event.type !== "raw") event.subagentId = parent;
    return true;
  }

  private toolProgress(msg: Record<string, unknown>, ts: number, out: AgentEvent[]): void {
    const toolCallId = str(msg["tool_use_id"]);
    const elapsed = num(msg["elapsed_time_seconds"]);
    if (toolCallId && elapsed !== undefined) out.push({ type: "tool.updated", runId: this.runId, ts, toolCallId, progress: `Running for ${Math.floor(elapsed)}s` });
  }

  /** Streamed blocks announce thinking, text and tools before the full assistant message arrives. */
  private streamEvent(msg: Record<string, unknown>, now: number, out: AgentEvent[]): void {
    const ev = msg["event"];
    if (!isRecord(ev)) {
      out.push(protocolError(this.runId, now, "Expected stream_event.event to be an object"));
      return;
    }
    if (ev["type"] === "message_start") {
      const message = ev["message"];
      if (!isRecord(message)) {
        out.push(protocolError(this.runId, now, "Expected message_start.message to be an object"));
        return;
      }
      this.currentMessageId = str(message["id"]) ?? this.currentMessageId;
      this.settleRequest(now, out);
    } else if (ev["type"] === "content_block_start") {
      const block = ev["content_block"];
      if (!isRecord(block)) {
        out.push(protocolError(this.runId, now, "Expected content_block_start.content_block to be an object"));
        return;
      }
      const index = num(ev["index"]) ?? null;
      if (block?.["type"] === "thinking" || block?.["type"] === "redacted_thinking") this.startThinking(index, now, out);
      else if (block?.["type"] === "tool_use" && typeof block["id"] === "string" && typeof block["name"] === "string") {
        this.finishThinking(now, out);
        this.toolNames.set(block["id"], block["name"]);
        this.toolsStarted.add(block["id"]);
        out.push({ type: "tool.started", runId: this.runId, ts: now, toolCallId: block["id"], name: block["name"], input: {}, parentToolCallId: str(msg["parent_tool_use_id"]) ?? null });
      } else this.finishThinking(now, out);
    } else if (ev["type"] === "content_block_stop") {
      if (this.thinking && this.thinking.index === (num(ev["index"]) ?? null)) this.finishThinking(now, out);
    } else if (ev["type"] === "message_stop") {
      this.finishThinking(now, out);
    } else if (ev["type"] === "content_block_delta") {
      const delta = ev["delta"];
      if (!isRecord(delta)) {
        out.push(protocolError(this.runId, now, "Expected content_block_delta.delta to be an object"));
        return;
      }
      const messageId = this.currentMessageId ?? "unknown";
      if (delta?.["type"] === "text_delta" && typeof delta["text"] === "string") {
        out.push({ type: "message.delta", runId: this.runId, ts: now, messageId, role: "assistant", text: delta["text"] });
      } else if (delta?.["type"] === "thinking_delta" && typeof delta["thinking"] === "string") {
        if (!this.thinking) this.startThinking(num(ev["index"]) ?? null, now, out);
        out.push({ type: "thinking.delta", runId: this.runId, ts: now, messageId, text: delta["thinking"] });
      }
    }
  }

  /**
   * Claude Code answers a request its login could not authorize with a stand-in assistant line. An account login is
   * fixed by signing in again; a key the user set keeps the CLI's own words.
   */
  private accountSignedOut(msg: Record<string, unknown>): boolean {
    return msg["error"] === "authentication_failed" && !USER_KEY_SOURCES.has(this.keySource ?? "");
  }

  private signInNeeded(msg: Record<string, unknown>, now: number, out: AgentEvent[]): void {
    this.settleRequest(now, out);
    this.finishThinking(now, out);
    out.push({
      type: "activity.updated",
      runId: this.runId,
      ts: now,
      activityId: `sign-in-${str(msg["uuid"]) ?? now}`,
      label: "Claude is signed out",
      status: "error",
      recovery: { kind: "sign_in", provider: "claude" },
    });
  }

  /** Complete assistant lines carry final text, full tool input and per-request context usage. */
  private assistant(msg: Record<string, unknown>, now: number, out: AgentEvent[]): void {
    const message = msg["message"];
    if (!isRecord(message)) {
      out.push(protocolError(this.runId, now, "Expected assistant.message to be an object"));
      return;
    }
    if (message["content"] !== undefined && !Array.isArray(message["content"])) {
      out.push(protocolError(this.runId, now, "Expected assistant.content to be an array"));
      return;
    }
    if (Array.isArray(message["content"]) && !message["content"].every(isRecord)) {
      out.push(protocolError(this.runId, now, "Expected assistant.content entries to be objects"));
      return;
    }
    const messageId = str(message["id"]) ?? "unknown";
    const parent = str(msg["parent_tool_use_id"]);
    if (!parent) {
      this.currentMessageId = messageId;
      this.settleRequest(now, out);
    }
    const content = Array.isArray(message["content"]) ? (message["content"] as Record<string, unknown>[]) : [];
    if (parent) {
      const thinking = content
        .filter((block) => block["type"] === "thinking")
        .map((block) => str(block["thinking"]) ?? "")
        .join("\n");
      if (thinking) {
        out.push({ type: "thinking.started", runId: this.runId, ts: now, messageId });
        out.push({ type: "thinking.completed", runId: this.runId, ts: now, messageId, text: thinking });
      }
    }
    const text = content
      .filter((b) => b["type"] === "text" && typeof b["text"] === "string")
      .map((b) => b["text"] as string)
      .join("");
    if (text.length > 0) {
      if (!parent) this.finishThinking(now, out);
      out.push({ type: "message.completed", runId: this.runId, ts: now, messageId, role: "assistant", text });
    }
    this.assistantTools(content, parent, now, out);
    const usage = readUsage(message["usage"], { context: true });
    if (usage) out.push({ type: "usage.updated", runId: this.runId, ts: now, usage });
  }

  private assistantTools(content: Record<string, unknown>[], parent: string | null, now: number, out: AgentEvent[]): void {
    for (const b of content) {
      if (b["type"] === "tool_use" && typeof b["id"] === "string" && typeof b["name"] === "string") {
        if (!parent) this.finishThinking(now, out);
        this.toolNames.set(b["id"], b["name"]);
        if (parent) this.toolParents.set(b["id"], parent);
        // A streamed block already announced the tool with an empty input; the full input arrives here.
        if (this.toolsStarted.has(b["id"])) out.push({ type: "tool.updated", runId: this.runId, ts: now, toolCallId: b["id"], input: b["input"] });
        else out.push({ type: "tool.started", runId: this.runId, ts: now, toolCallId: b["id"], name: b["name"], input: b["input"], parentToolCallId: parent ?? null });
        if (b["name"] === "Agent" || b["name"] === "Task") this.subagents.launch(b["id"], b["input"], parent, now, out);
        if (b["name"] === "Skill") this.subagents.skill(b["id"]);
        if (b["name"] === "Workflow") this.workflows.launch(b["id"], b["input"], parent, now, out);
      }
    }
  }

  /** Tool results arrive on user lines and retain the names from their earlier tool starts. */
  private user(msg: Record<string, unknown>, now: number, out: AgentEvent[]): void {
    const message = msg["message"];
    if (!isRecord(message)) {
      out.push(protocolError(this.runId, now, "Expected user.message to be an object"));
      return;
    }
    if (Array.isArray(message["content"]) && !message["content"].every(isRecord)) {
      out.push(protocolError(this.runId, now, "Expected user.content entries to be objects"));
      return;
    }
    const content = Array.isArray(message["content"]) ? (message["content"] as Record<string, unknown>[]) : [];
    if (str(msg["parent_tool_use_id"])) {
      const text =
        str(message["content"]) ??
        content
          .filter((block) => block["type"] === "text")
          .map((block) => str(block["text"]) ?? "")
          .join("\n");
      if (text && !/^\[Request interrupted by user(?: for tool use)?\]$/.test(text.trim()) && !this.subagents.duplicatePrompt(String(msg["parent_tool_use_id"]), text))
        out.push({ type: "message.completed", runId: this.runId, ts: now, messageId: str(msg["uuid"]) ?? `child-input-${++this.childInputs}`, role: "user", text });
    }
    for (const b of content) {
      if (b["type"] === "tool_result" && typeof b["tool_use_id"] === "string") {
        out.push({
          type: "tool.completed",
          runId: this.runId,
          ts: now,
          toolCallId: b["tool_use_id"],
          name: this.toolNames.get(b["tool_use_id"]) ?? "unknown",
          output: b["content"],
          isError: b["is_error"] === true,
        });
        this.subagents.result(b["tool_use_id"], b["content"], b["is_error"] === true, now, out);
        this.workflows.result(b["tool_use_id"], b["is_error"] === true, now, out);
      }
    }
  }

  /** Usage warnings stay notices; rejected windows become recoverable activities. */
  private rateLimit(msg: Record<string, unknown>, now: number, out: AgentEvent[]): void {
    const rawInfo = msg["rate_limit_info"];
    if (rawInfo !== undefined && !isRecord(rawInfo)) {
      out.push(protocolError(this.runId, now, "Expected rate_limit_info to be an object"));
      return;
    }
    const info = rawInfo as Record<string, unknown> | undefined;
    const status = str(info?.["status"]);
    if (!status || status === "allowed") return;
    const resetsAt = num(info?.["resetsAt"]);
    const resetPhrase = formatResetMoment(resetsAt, str(info?.["rateLimitType"]));
    const id = `rate-limit-${resetsAt ?? now}`;
    // Claude Code sends a heads-up at a utilization threshold ("allowed_warning") long
    // before it refuses anything, and the turn it arrives on runs to completion. That is
    // a notice, not a failure: only a status the provider did not allow gets the red row.
    if (status.startsWith("allowed")) {
      out.push({ type: "message.completed", runId: this.runId, ts: now, messageId: id, role: "system", text: usageNotice(info, resetPhrase) });
      return;
    }
    out.push({
      type: "activity.updated",
      runId: this.runId,
      ts: now,
      activityId: id,
      label: "Rate limit reached",
      status: "error",
      text: resetPhrase ? `Resets ${resetPhrase}.` : "The provider is rate limiting this account.",
      detail: info,
      ...(status === "rejected" ? { recovery: { kind: "usage" as const, provider: "claude" as const } } : {}),
    });
  }

  /** A result settles the current request, then accounts for the turn and Fast state. */
  private result(msg: Record<string, unknown>, now: number, out: AgentEvent[]): void {
    const modelTurns = num(msg["num_turns"]) ?? 0;
    // A manual compaction ends with a result of its own, which answered nothing.
    if (this.swallowEmptyResult) {
      this.swallowEmptyResult = false;
      if (modelTurns === 0) return;
    }
    this.settleRequest(now, out);
    this.finishThinking(now, out);
    const subtype = str(msg["subtype"]) ?? "success";
    const isError = msg["is_error"] === true;
    this.subagents.turnEnded(isError, now, out);
    const usage = readUsage(msg["usage"], { costUsd: num(msg["total_cost_usd"]), context: false });
    const contextWindow = readContextWindow(msg["modelUsage"], this.model);
    if (usage && contextWindow !== undefined) usage.contextWindow = contextWindow;
    out.push({
      type: "turn.completed",
      runId: this.runId,
      ts: now,
      turnId: str(msg["uuid"]) ?? str(msg["session_id"]) ?? "turn",
      status: resultStatus(isError, subtype),
      ...(typeof msg["result"] === "string" ? { resultText: msg["result"] } : {}),
      ...(usage ? { usage } : {}),
      durationMs: num(msg["duration_ms"]) ?? 0,
      ...fastModeServed(msg, this.fastMode),
    });
    this.turns += modelTurns;
    this.reportFastMode(msg, now, out);
  }

  /** `system` lines: the session, each turn's start, and what Claude Code is doing between model messages. */
  private system(msg: Record<string, unknown>, now: number, out: AgentEvent[]): void {
    if (
      this.workflows.task(msg, now, out) ||
      this.subagents.task(
        msg,
        now,
        out,
        this.transcriptTargets().some((target) => !target.finished),
      )
    ) {
      const taskId = str(msg["task_id"]);
      if (taskId) this.taskPlaces.set(taskId, "elsewhere");
      return;
    }
    const subtype = msg["subtype"];
    if (subtype === "init") {
      this.model = str(msg["model"]);
      this.keySource = str(msg["apiKeySource"]);
      if (!this.announced) {
        this.announced = true;
        out.push({
          type: "session.started",
          runId: this.runId,
          ts: now,
          agent: "claude",
          externalSessionId: sessionId(msg["session_id"]),
          model: str(msg["model"]),
          ...(Array.isArray(msg["capabilities"]) ? { capabilities: msg["capabilities"].filter(isString) } : {}),
          ...(Array.isArray(msg["tools"]) ? { tools: msg["tools"].filter(isString) } : {}),
        });
      }
      // Compaction re-announces the session without a prompt; that is not a turn.
      if (!this.compaction) {
        this.starts += 1;
        out.push({ type: "turn.started", runId: this.runId, ts: now, turnId: str(msg["uuid"]) ?? `turn-${this.starts}` });
      }
      this.reportFastMode(msg, now, out);
      return;
    }
    // Out of usage credits, Claude Code retries each Fast request at standard speed and says so once per turn.
    if (subtype === "notification" && msg["key"] === "fast-mode-overage-rejected") {
      const text = str(msg["text"]);
      if (text) this.fastModeNotice(text, now, out);
      return;
    }
    if (subtype === "status") {
      const status = str(msg["status"]);
      if (status === "requesting") {
        this.settleRequest(now, out);
        this.requests += 1;
        this.requesting = `request-${this.requests}`;
        out.push({ type: "activity.updated", runId: this.runId, ts: now, activityId: this.requesting, label: "Waiting for Claude", status: "running" });
      } else if (status === "compacting") {
        if (this.compaction) return;
        this.compactions += 1;
        this.compaction = { id: `compaction-${this.compactions}`, manual: this.manualCompactionRequested };
        this.manualCompactionRequested = false;
        out.push({
          type: "activity.updated",
          runId: this.runId,
          ts: now,
          activityId: this.compaction.id,
          label: "Compacting context",
          status: "running",
          detail: { mode: this.compaction.manual ? "manual" : "automatic" },
        });
      } else if (msg["compact_result"] !== undefined && this.compaction) {
        const result = str(msg["compact_result"]);
        if (result !== "success") {
          out.push({
            type: "activity.updated",
            runId: this.runId,
            ts: now,
            activityId: this.compaction.id,
            label: "Compacting context",
            status: "error",
            text: str(msg["error"]) ?? `Compaction ${result ?? "failed"}.`,
          });
          this.compaction = null;
        } else if (this.compaction.manual) this.swallowEmptyResult = true;
      }
      return;
    }
    if (subtype === "compact_boundary") {
      this.compactBoundary(msg, now, out);
      return;
    }
    if (subtype === "thinking_tokens") {
      if (!this.thinking) this.startThinking(null, now, out);
      return;
    }
    if (subtype === "task_summary") {
      // This describes the whole session, not the last tool or agent that happened to launch.
      return;
    }
    if (subtype === "background_tasks_changed") {
      this.backgroundTasksChanged(msg["tasks"], now, out);
      return;
    }
    if (subtype === "task_started" || subtype === "task_notification") {
      // Housekeeping tasks stay out of the transcript, as Claude Code asks of hosts.
      if (msg["skip_transcript"] === true || msg["ambient"] === true) return;
      const toolCallId = str(msg["tool_use_id"]);
      const taskId = str(msg["task_id"]);
      // A notification has no description; its summary becomes the row's label.
      const description = str(msg["description"]) ?? str(msg["summary"]) ?? "Background task";
      const finished = subtype === "task_notification";
      const failed = finished && str(msg["status"]) !== "completed";
      if (toolCallId && this.toolParents.has(toolCallId)) {
        if (taskId) this.taskPlaces.set(taskId, "elsewhere");
        return;
      }
      if (toolCallId && this.toolNames.has(toolCallId)) {
        // The task belongs to a tool call the transcript already shows; report on that row.
        if (taskId) this.taskPlaces.set(taskId, "elsewhere");
        if (!finished) out.push({ type: "tool.updated", runId: this.runId, ts: now, toolCallId, progress: description });
        return;
      }
      if (!this.trackStandaloneTask(msg, taskId, toolCallId)) return;
      out.push({
        type: "activity.updated",
        runId: this.runId,
        ts: now,
        activityId: `task-${taskId ?? toolCallId ?? now}`,
        label: description,
        status: backgroundStatus(finished, failed),
      });
      return;
    }
  }

  /**
   * The boundary closes a compaction, manual or automatic, and says what the conversation shrank to. That size is the
   * context's new fill, reported ahead of the activity so the ring reads it as the compaction settles; no model request
   * reports it, since the result that follows a manual compaction spends nothing and is no turn.
   */
  private compactBoundary(msg: Record<string, unknown>, now: number, out: AgentEvent[]): void {
    const rawMeta = msg["compact_metadata"];
    if (rawMeta !== undefined && !isRecord(rawMeta)) {
      out.push(protocolError(this.runId, now, "Expected compact_metadata to be an object"));
      return;
    }
    const meta = rawMeta as Record<string, unknown> | undefined;
    const pre = num(meta?.["pre_tokens"]);
    const post = num(meta?.["post_tokens"]);
    if (post !== undefined) out.push({ type: "context.updated", runId: this.runId, ts: now, contextTokens: post });
    const text = pre !== undefined && post !== undefined ? `${pre.toLocaleString()} tokens folded into ${post.toLocaleString()}.` : undefined;
    const trigger = str(meta?.["trigger"]);
    out.push({
      type: "activity.updated",
      runId: this.runId,
      ts: now,
      activityId: this.compaction?.id ?? `compaction-${++this.compactions}`,
      label: "Compacting context",
      status: "success",
      ...(text ? { text } : {}),
      detail: { mode: trigger === "manual" || this.compaction?.manual ? "manual" : "automatic" },
    });
    this.compaction = null;
  }

  private trackStandaloneTask(msg: Record<string, unknown>, taskId: string | null, toolCallId: string | null): boolean {
    const place = taskId ? this.taskPlaces.get(taskId) : undefined;
    // An unseen shell call belongs to a subagent. Its parent call stands for that work, including later resumptions.
    if (place === "elsewhere" || (toolCallId && str(msg["task_type"]) === "local_bash")) {
      if (taskId) this.taskPlaces.set(taskId, "elsewhere");
      return false;
    }
    // A resumed process reports the last one's unfinished tasks without a run id; their rows already closed.
    if (msg["subtype"] === "task_notification" && !place && msg["run_id"] === undefined) return false;
    if (taskId) this.taskPlaces.set(taskId, "own");
    return true;
  }

  /**
   * Every task running in the background, replacing the last list. Ambient tasks, such as watchers, are housekeeping
   * rather than work; Claude Code asks hosts to leave them out of activity.
   */
  private backgroundTasksChanged(rawTasks: unknown, now: number, out: AgentEvent[]): void {
    if (rawTasks !== undefined && !Array.isArray(rawTasks)) {
      out.push(protocolError(this.runId, now, "Expected background tasks to be an array"));
      return;
    }
    if (Array.isArray(rawTasks) && !rawTasks.every(isRecord)) {
      out.push(protocolError(this.runId, now, "Expected background task entries to be objects"));
      return;
    }
    const work: string[] = [];
    const commands: BackgroundCommand[] = [];
    for (const task of (rawTasks ?? []) as Record<string, unknown>[]) {
      const id = str(task["task_id"]);
      if (!id || task["ambient"] === true) continue;
      if (BACKGROUND_WORK.has(str(task["task_type"]) ?? "")) work.push(id);
      else commands.push({ id, description: str(task["description"]) ?? "Background command" });
    }
    const changed = work.length !== this.background.work.length || !sameCommands(commands, this.background.commands);
    this.background = { work, commands };
    if (changed) out.push({ type: "background.updated", runId: this.runId, ts: now, running: work.length, commands });
  }

  /**
   * A run that asked for Fast says so when Claude Code does not serve it, and
   * again when it comes back. Init and result lines both carry the state, so
   * only changes are reported; an account check still pending says nothing yet.
   */
  private reportFastMode(msg: Record<string, unknown>, now: number, out: AgentEvent[]): void {
    const state = str(msg["fast_mode_state"]);
    const code = str(msg["fast_mode_disabled_reason"]);
    if (!this.fastMode || (state !== "on" && state !== "off" && state !== "cooldown") || (state === "off" && code === "pending")) return;
    const key = state === "off" ? `off:${code ?? ""}` : state;
    if (key === this.fastModeState) return;
    const first = this.fastModeState === null;
    this.fastModeState = key;
    if (state === "on") {
      if (!first) this.fastModeNotice("Fast mode is back on.", now, out);
    } else if (state === "cooldown") {
      this.fastModeNotice("Claude is answering at standard speed until Fast mode's rate limit resets.", now, out);
    } else {
      this.fastModeNotice(`Claude is answering at standard speed. ${claudeFastModeReason(code) ?? "Claude Code did not turn Fast mode on for this session."}`, now, out);
    }
  }

  private fastModeNotice(text: string, now: number, out: AgentEvent[]): void {
    this.fastModeNotices += 1;
    out.push({ type: "message.completed", runId: this.runId, ts: now, messageId: `fast-mode-${this.runId}-${this.fastModeNotices}`, role: "system", text });
  }

  private settleRequest(now: number, out: AgentEvent[]): void {
    if (!this.requesting) return;
    out.push({ type: "activity.updated", runId: this.runId, ts: now, activityId: this.requesting, label: "Waiting for Claude", status: "success" });
    this.requesting = null;
  }

  private startThinking(index: number | null, now: number, out: AgentEvent[]): void {
    if (this.thinking) return;
    this.settleRequest(now, out);
    this.thinking = { messageId: this.currentMessageId ?? "unknown", index };
    out.push({ type: "thinking.started", runId: this.runId, ts: now, messageId: this.thinking.messageId });
  }

  private finishThinking(now: number, out: AgentEvent[]): void {
    if (!this.thinking) return;
    out.push({ type: "thinking.completed", runId: this.runId, ts: now, messageId: this.thinking.messageId });
    this.thinking = null;
  }
}

/** Blank and malformed lines stop here; object events reach the stateful parser unchanged. */
function decodeStreamLine(line: string, runId: string, now: number): { kind: "events"; events: AgentEvent[] } | { kind: "message"; message: Record<string, unknown> } {
  if (line.trim().length === 0) return { kind: "events", events: [] };
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch {
    return { kind: "events", events: [{ type: "error", runId, ts: now, message: `unparseable line: ${line.slice(0, 200)}`, fatal: false }] };
  }
  if (!isRecord(decoded)) return { kind: "events", events: [protocolError(runId, now, "Expected a stream event object")] };
  return { kind: "message", message: decoded };
}

const usageWindows: Record<string, string> = { five_hour: "five-hour", seven_day: "weekly", monthly: "monthly" };

function formatResetMoment(resetsAt: number | undefined, limitType: string | null): string | null {
  if (!resetsAt) return null;
  const reset = new Date(resetsAt * 1000);
  const time = reset.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return limitType === "seven_day" ? `on ${reset.toLocaleDateString([], { weekday: "long" })} at ${time}` : `at ${time}`;
}

/**
 * The usage heads-up in the words a person would use: how much of which window
 * is gone, and when it comes back. No payload; nothing here needs inspecting.
 */
export function usageNotice(info: Record<string, unknown> | undefined, resetPhrase: string | null): string {
  const share = num(info?.["utilization"]);
  const window = usageWindows[str(info?.["rateLimitType"]) ?? ""] ?? "usage";
  const used = share === undefined ? `You are close to your ${window} limit` : `You have used ${Math.round(share * 100)}% of your ${window} limit`;
  return `${used}.${resetPhrase ? ` It resets ${resetPhrase}.` : ""}`;
}

/** For a turn that asked for Fast, whether it was served. Only a result line knows: init lines say on before any request has been refused. */
function fastModeServed(msg: Record<string, unknown>, asked: boolean): Pick<Extract<AgentEvent, { type: "turn.completed" }>, "fastMode"> {
  const state = str(msg["fast_mode_state"]);
  const code = str(msg["fast_mode_disabled_reason"]);
  if (!asked || (state !== "on" && state !== "off" && state !== "cooldown")) return {};
  return { fastMode: { state, ...(code ? { code } : {}) } };
}

/** The window of the session's model from a result's per-model usage map; the first entry when the init line named none. */
function readContextWindow(modelUsage: unknown, model: string | null): number | undefined {
  if (!modelUsage || typeof modelUsage !== "object") return undefined;
  const map = modelUsage as Record<string, unknown>;
  const entry = (model && map[model]) ?? Object.values(map)[0];
  if (!entry || typeof entry !== "object") return undefined;
  const window = num((entry as Record<string, unknown>)["contextWindow"]);
  return window !== undefined && window > 0 ? window : undefined;
}
function isString(v: unknown): v is string {
  return typeof v === "string";
}

function protocolError(runId: string, ts: number, message: string): AgentEvent {
  return { type: "error", runId, ts, message: `Malformed Claude stream line: ${message}`, fatal: false };
}
/**
 * An assistant line's usage is one request, so what the model read is the size
 * of the conversation. A result line sums every request of the turn, which says
 * nothing about context size, so it carries no contextTokens.
 */
function readUsage(v: unknown, options: { costUsd?: number; context: boolean }): Usage | null {
  if (!v || typeof v !== "object") return null;
  const u = v as Record<string, unknown>;
  const inputTokens = num(u["input_tokens"]);
  const outputTokens = num(u["output_tokens"]);
  if (inputTokens === undefined || outputTokens === undefined) return null;
  const cacheRead = num(u["cache_read_input_tokens"]);
  const cacheWrite = num(u["cache_creation_input_tokens"]);
  return {
    inputTokens,
    outputTokens,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
    ...(options.costUsd !== undefined ? { costUsd: options.costUsd } : {}),
    ...(options.context ? { contextTokens: inputTokens + (cacheRead ?? 0) + (cacheWrite ?? 0) } : {}),
  };
}
