import type { ActivityStatus, AgentEvent, Usage, McpToolSource } from "@openorc/protocol";

export interface NotificationState {
  summaryIndex: Map<string, number>;
  buffering: Set<string>;
  mcpSources?: Map<string, McpToolSource>;
}

/** Unknown notifications stay ledger-only, including providers that send positional params. */
const MAPPED_METHODS = new Set([
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/mcpToolCall/progress",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/patchUpdated",
  "item/plan/delta",
  "model/safetyBuffering/updated",
  "turn/diff/updated",
  "turn/plan/updated",
  "hook/started",
  "hook/completed",
  "item/autoApprovalReview/started",
  "item/autoApprovalReview/completed",
  "modelProvider/authRecoveryStarted",
  "modelProvider/authRecoveryCompleted",
  "warning",
  "guardianWarning",
  "configWarning",
  "deprecationNotice",
  "model/rerouted",
  "autoApprovalReview/strictReviewRequired",
  "item/reasoning/summaryTextDelta",
  "item/started",
  "item/completed",
  "turn/completed",
  "thread/tokenUsage/updated",
  "error",
]);

interface NotificationContext {
  runId: string;
  method: string;
  p: Record<string, unknown>;
  params: unknown;
  state: NotificationState;
  ts: number;
}

/** Validate recognized envelopes once; each family validates its own nested records before state changes. */
export function mapNotification(runId: string, method: string, params: unknown, state: NotificationState): AgentEvent[] {
  if (!MAPPED_METHODS.has(method)) return [];
  const ts = Date.now();
  if (params !== undefined && !isRecord(params)) return [protocolError(runId, ts, method, "Expected params to be an object")];
  const context: NotificationContext = { runId, method, p: params ?? {}, params, state, ts };
  if (method === "item/started" || method === "item/completed") return mapItemLifecycle(context);
  if (method === "turn/completed" || method === "thread/tokenUsage/updated" || method === "error") return mapCompletion(context);
  if (method === "item/reasoning/summaryTextDelta") return mapReasoningSummary(context);
  return mapActivityNotice(context) ?? mapIncrementalEvent(context);
}

/** Message, tool-output, plan and buffering updates preserve their stream order. */
function mapIncrementalEvent({ runId, method, p, state, ts }: NotificationContext): AgentEvent[] {
  const { buffering } = state;
  const out: AgentEvent[] = [];
  if (method === "item/agentMessage/delta" && typeof p["delta"] === "string") {
    out.push({ type: "message.delta", runId, ts, messageId: String(p["itemId"]), role: "assistant", text: p["delta"] });
    return out;
  }
  if ((method === "item/commandExecution/outputDelta" || method === "item/fileChange/outputDelta") && typeof p["delta"] === "string") {
    return [{ type: "tool.output.delta", runId, ts, toolCallId: String(p["itemId"]), text: p["delta"] }];
  }
  if (method === "item/mcpToolCall/progress" || method === "item/commandExecution/terminalInteraction" || method === "item/fileChange/patchUpdated") {
    return [
      {
        type: "tool.updated",
        runId,
        ts,
        toolCallId: String(p["itemId"]),
        ...incrementalToolUpdate(method, p),
      },
    ];
  }
  if (method === "item/plan/delta" && typeof p["delta"] === "string") {
    return [
      { type: "plan.updated", runId, ts, documentId: String(p["itemId"]), text: p["delta"], delta: true },
      { type: "activity.delta", runId, ts, activityId: String(p["itemId"]), label: "Planning", text: p["delta"] },
    ];
  }
  if (method === "model/safetyBuffering/updated") {
    const id = `buffering-${String(p["turnId"])}`;
    if (p["showBufferingUi"] !== true && !buffering.has(id)) return out;
    if (p["showBufferingUi"] === true) buffering.add(id);
    else buffering.delete(id);
    return [
      {
        type: "activity.updated",
        runId,
        ts,
        activityId: id,
        label: "Waiting for provider response",
        status: p["showBufferingUi"] === true ? "running" : "success",
        detail: { model: p["model"], reasons: p["reasons"] },
      },
    ];
  }
  if (method === "turn/diff/updated") {
    return [{ type: "activity.updated", runId, ts, activityId: `diff-${String(p["turnId"])}`, label: "Changes", status: "success", text: String(p["diff"] ?? "") }];
  }
  if (method === "turn/plan/updated") {
    if (p["plan"] !== undefined && !Array.isArray(p["plan"])) return [protocolError(runId, ts, method, "Expected plan to be an array")];
    if (Array.isArray(p["plan"]) && !p["plan"].every(isRecord)) return [protocolError(runId, ts, method, "Expected plan entries to be objects")];
    const plan = Array.isArray(p["plan"]) ? (p["plan"] as Record<string, unknown>[]) : [];
    return [
      {
        type: "activity.updated",
        runId,
        ts,
        activityId: `plan-${String(p["turnId"])}`,
        label: "Plan",
        status: plan.every((step) => step["status"] === "completed") ? "success" : "running",
        text: [p["explanation"], ...plan.map((step) => `${String(step["status"])}: ${String(step["step"])}`)].filter(Boolean).join("\n"),
      },
    ];
  }
  return out;
}

/** Provider notices, hooks and automatic reviews are activities, not turn settlement. */
function mapActivityNotice({ runId, method, p, ts }: NotificationContext): AgentEvent[] | null {
  if (method === "hook/started" || method === "hook/completed") {
    const hook = record(p["run"]);
    return [
      {
        type: "activity.updated",
        runId,
        ts,
        activityId: `hook-${String(hook["id"])}`,
        label: `Hook: ${String(hook["eventName"] ?? "running")}`,
        status: method.endsWith("started") ? "running" : terminalStatus(hook["status"]),
        text: String(hook["statusMessage"] ?? ""),
        detail: hook["entries"],
      },
    ];
  }
  if (method === "item/autoApprovalReview/started" || method === "item/autoApprovalReview/completed") {
    const review = record(p["review"]);
    return [
      {
        type: "activity.updated",
        runId,
        ts,
        activityId: `review-${String(p["reviewId"])}`,
        label: "Automatic approval review",
        status: method.endsWith("started") ? "running" : terminalStatus(review["status"]),
        text: String(review["rationale"] ?? ""),
        detail: { action: p["action"], review: p["review"] },
      },
    ];
  }
  if (method === "modelProvider/authRecoveryStarted" || method === "modelProvider/authRecoveryCompleted") {
    return [
      {
        type: "activity.updated",
        runId,
        ts,
        activityId: `auth-${String(p["turnId"])}-${String(p["provider"])}`,
        label: "Restoring provider connection",
        status: method.endsWith("Started") ? "running" : "success",
        text: String(p["message"] ?? ""),
      },
    ];
  }
  if (["warning", "guardianWarning", "configWarning", "deprecationNotice", "model/rerouted", "autoApprovalReview/strictReviewRequired"].includes(method)) {
    const text =
      method === "model/rerouted" ? `Model changed from ${String(p["fromModel"])} to ${String(p["toModel"])}` : String(p["message"] ?? p["summary"] ?? "Automatic approval requires strict review");
    return [
      {
        type: "activity.updated",
        runId,
        ts,
        activityId: `${method}-${String(p["turnId"] ?? "")}-${text}`,
        label: method === "model/rerouted" ? "Model changed" : "Provider notice",
        status: "success",
        text,
        detail: p["details"],
      },
    ];
  }
  return null;
}

/** Summary paragraph boundaries stay in the same mutable state as item completion. */
function mapReasoningSummary({ runId, method, p, state, ts }: NotificationContext): AgentEvent[] {
  const { summaryIndex } = state;
  const out: AgentEvent[] = [];
  // Reasoning arrives as summaries (what the Codex app shows), one paragraph per summaryIndex. Raw reasoning remains ledger-only.
  if (method === "item/reasoning/summaryTextDelta" && typeof p["delta"] === "string") {
    const itemId = String(p["itemId"]);
    const index = typeof p["summaryIndex"] === "number" ? p["summaryIndex"] : 0;
    const previous = summaryIndex.get(itemId);
    summaryIndex.set(itemId, index);
    const text = previous !== undefined && index !== previous ? `\n\n${p["delta"]}` : p["delta"];
    out.push({ type: "thinking.delta", runId, ts, messageId: itemId, text });
    return out;
  }
  return out;
}

/** An item family validates its nested record before emitting or mutating tool/reasoning state. */
function mapItemLifecycle({ runId, method, p, state, ts }: NotificationContext): AgentEvent[] {
  const { summaryIndex } = state;
  const out: AgentEvent[] = [];
  if (method === "item/started" || method === "item/completed") {
    const item = p["item"];
    if (!isRecord(item)) return [protocolError(runId, ts, method, "Expected item to be an object")];
    const id = String(item["id"]);
    const started = method === "item/started";
    switch (item["type"]) {
      case "reasoning": {
        if (started) out.push({ type: "thinking.started", runId, ts, messageId: id });
        else {
          const summary = Array.isArray(item["summary"]) ? item["summary"].filter((part): part is string => typeof part === "string").join("\n\n") : "";
          out.push({ type: "thinking.completed", runId, ts, messageId: id, ...(summary ? { text: summary } : {}) });
          summaryIndex.delete(id);
        }
        break;
      }
      case "contextCompaction":
      case "userMessage":
        // Compaction is emitted by the adapter's maintenance controller. User
        // messages are recorded by the host when input is accepted.
        break;
      case "plan":
        out.push({ type: "activity.updated", runId, ts, activityId: id, label: "Plan", status: started ? "running" : "success", text: typeof item["text"] === "string" ? item["text"] : "" });
        out.push({ type: "plan.updated", runId, ts, documentId: id, text: typeof item["text"] === "string" ? item["text"] : "", complete: !started });
        break;
      case "agentMessage":
        if (started) out.push({ type: "message.delta", runId, ts, messageId: id, role: "assistant", text: "" });
        if (!started && typeof item["text"] === "string") {
          out.push({ type: "message.completed", runId, ts, messageId: id, role: "assistant", text: item["text"] });
        }
        break;
      case "commandExecution":
        if (started) {
          out.push({ type: "tool.started", runId, ts, toolCallId: id, name: "shell", input: { command: item["command"], cwd: item["cwd"] }, parentToolCallId: null });
        } else {
          out.push({
            type: "tool.completed",
            runId,
            ts,
            toolCallId: id,
            name: "shell",
            output: item["aggregatedOutput"],
            isError: terminalStatus(item["status"]) === "error" || (typeof item["exitCode"] === "number" && item["exitCode"] !== 0),
            status: typeof item["exitCode"] === "number" && item["exitCode"] !== 0 ? "error" : terminalStatus(item["status"]),
            input: { command: item["command"], cwd: item["cwd"] },
          });
        }
        break;
      case "fileChange": {
        if (item["changes"] !== undefined && !Array.isArray(item["changes"])) return [protocolError(runId, ts, method, "Expected file changes to be an array")];
        if (Array.isArray(item["changes"]) && !item["changes"].every(isRecord)) return [protocolError(runId, ts, method, "Expected file changes to be objects")];
        const changes = Array.isArray(item["changes"]) ? (item["changes"] as Record<string, unknown>[]) : [];
        if (started) {
          out.push({ type: "tool.started", runId, ts, toolCallId: id, name: "apply_patch", input: changes, parentToolCallId: null });
        } else {
          out.push({
            type: "tool.completed",
            runId,
            ts,
            toolCallId: id,
            name: "apply_patch",
            output: undefined,
            input: changes,
            status: terminalStatus(item["status"]),
            isError: terminalStatus(item["status"]) === "error",
          });
          for (const c of changes) {
            if (typeof c["path"] !== "string") continue;
            out.push({ type: "file.changed", runId, ts, path: c["path"], kind: fileChangeKind(c["kind"]) });
          }
        }
        break;
      }
      case "mcpToolCall": {
        const name = `${String(item["server"])}.${String(item["tool"])}`;
        const app = record(item["appContext"]);
        const mcp = {
          ...state.mcpSources?.get(id),
          server: String(item["server"]),
          tool: String(item["tool"]),
          ...(typeof app["resourceUri"] === "string" ? { resourceUri: app["resourceUri"] } : {}),
          ...(typeof app["connectorId"] === "string" ? { connectorId: app["connectorId"] } : {}),
        };
        if (started) {
          (state.mcpSources ??= new Map()).set(id, mcp);
          out.push({ type: "tool.started", runId, ts, toolCallId: id, name, input: item["arguments"], parentToolCallId: null, mcp });
        } else {
          state.mcpSources?.delete(id);
          out.push({
            type: "tool.completed",
            runId,
            ts,
            toolCallId: id,
            name,
            output: item["result"] ?? item["error"],
            mcp,
            isError: item["error"] != null || terminalStatus(item["status"]) === "error",
            status: item["error"] != null ? "error" : terminalStatus(item["status"]),
            input: item["arguments"],
          });
        }
        break;
      }
      case "dynamicToolCall": {
        const name = [item["namespace"], item["tool"]].filter(Boolean).join(".");
        if (started) out.push({ type: "tool.started", runId, ts, toolCallId: id, name, input: item["arguments"], parentToolCallId: null });
        else
          out.push({
            type: "tool.completed",
            runId,
            ts,
            toolCallId: id,
            name,
            input: item["arguments"],
            output: item["contentItems"],
            isError: item["success"] === false || terminalStatus(item["status"]) === "error",
            status: item["success"] === false ? "error" : terminalStatus(item["status"]),
          });
        break;
      }
      case "imageGeneration": {
        const { result, ...detail } = item;
        const status = itemActivityStatus(started, item["failure"], item["status"]);
        const path = item["savedPath"];
        out.push({
          type: "activity.updated",
          runId,
          ts,
          activityId: id,
          activityKind: "image_generation",
          label: imageGenerationLabel(started, status),
          status,
          text: item["failure"] ? String(item["failure"]) : "",
          detail,
          ...(!started && status === "success" && typeof path === "string" && path ? { imagePath: path } : {}),
        });
        break;
      }
      case "webSearch":
      case "collabAgentToolCall":
      case "subAgentActivity":
      case "imageView":
      case "sleep":
      case "enteredReviewMode":
      case "exitedReviewMode":
      case "hookPrompt":
      case "functionCallOutput": {
        const labels: Record<string, string> = {
          webSearch: "Searching the web",
          collabAgentToolCall: `Agent: ${String(item["tool"] ?? "delegating")}`,
          subAgentActivity: `Agent ${String(item["agentPath"] ?? "")}: ${String(item["kind"] ?? "activity")}`,
          imageView: "Viewing image",
          sleep: "Waiting",
          enteredReviewMode: "Entering review",
          exitedReviewMode: "Leaving review",
          hookPrompt: "Hook context",
          functionCallOutput: `Tool output: ${String(item["name"] ?? "")}`,
        };
        const { result, ...detail } = item;
        out.push({
          type: "activity.updated",
          runId,
          ts,
          activityId: id,
          label: labels[String(item["type"])]!,
          status: itemActivityStatus(started, item["failure"], item["status"]),
          text: String(item["query"] ?? item["path"] ?? item["prompt"] ?? item["review"] ?? item["savedPath"] ?? item["revisedPrompt"] ?? ""),
          detail,
        });
        break;
      }
      default:
        // Future provider items remain visible without pretending to understand
        // their contents. Transport notifications never take this path.
        out.push({ type: "activity.updated", runId, ts, activityId: id, label: `Codex activity: ${String(item["type"])}`, status: started ? "running" : terminalStatus(item["status"]), detail: item });
        break;
    }
    return out;
  }
  return out;
}

/** A validated completion clears per-turn state and emits its final events in order. */
function mapCompletion({ runId, method, p, params, state, ts }: NotificationContext): AgentEvent[] {
  const { summaryIndex, buffering } = state;
  const out: AgentEvent[] = [];
  if (method === "turn/completed") {
    const turn = p["turn"];
    if (!isRecord(turn)) return [protocolError(runId, ts, method, "Expected turn to be an object")];
    const status = turn?.["status"];
    buffering.delete(`buffering-${String(turn?.["id"])}`);
    summaryIndex.clear();
    const error = record(turn?.["error"]);
    if (typeof error["message"] === "string") {
      out.push({
        type: "activity.updated",
        runId,
        ts,
        activityId: `error-${String(turn?.["id"])}-${error["message"]}`,
        label: "Provider error",
        status: "error",
        text: error["message"],
        ...quotaRecovery(error),
      });
    }
    out.push({
      type: "turn.completed",
      runId,
      ts,
      turnId: String(turn?.["id"] ?? "turn"),
      status: completedTurnStatus(status),
      durationMs: typeof turn?.["durationMs"] === "number" ? turn["durationMs"] : 0,
    });
    return out;
  }
  if (method === "thread/tokenUsage/updated") {
    const usage = readTokenUsage(p);
    if (usage) out.push({ type: "usage.updated", runId, ts, usage });
    return out;
  }
  if (method === "error") {
    const error = record(p["error"]);
    out.push({
      type: "activity.updated",
      runId,
      ts,
      activityId: `error-${String(p["turnId"])}-${String(error["message"])}`,
      label: p["willRetry"] ? "Retrying" : "Provider error",
      ...(p["willRetry"] ? {} : quotaRecovery(error)),
      status: p["willRetry"] ? "running" : "error",
      text: String(error["message"] ?? JSON.stringify(params)),
    });
    if (p["willRetry"] === false) out.push({ type: "error", runId, ts, message: String(error["message"] ?? JSON.stringify(params)), fatal: true });
  }
  return out;
}

/** Only a structured quota error offers account recovery; HTTP 429 alone is not enough. */
function quotaRecovery(error: Record<string, unknown>): { recovery?: { kind: "usage"; provider: "codex" } } {
  const info = error["codexErrorInfo"];
  const variants = typeof info === "string" ? [info] : Object.keys(record(info));
  return variants.some((value) => value.toLowerCase() === "usagelimitexceeded") ? { recovery: { kind: "usage", provider: "codex" } } : {};
}

/** Codex reports totals per thread plus the last turn and the model's window; the shape has moved before, so read it loosely. */
function readTokenUsage(p: Record<string, unknown>): Usage | null {
  const holder = (p["tokenUsage"] ?? p["usage"] ?? p) as Record<string, unknown>;
  const total = (holder["total"] ?? holder) as Record<string, unknown>;
  const last = (holder["last"] ?? null) as Record<string, unknown> | null;
  const num = (o: Record<string, unknown>, k: string) => (typeof o[k] === "number" ? (o[k] as number) : undefined);
  const inputTokens = num(total, "inputTokens") ?? num(total, "input_tokens");
  const outputTokens = num(total, "outputTokens") ?? num(total, "output_tokens");
  if (inputTokens === undefined || outputTokens === undefined) return null;
  const cached = num(total, "cachedInputTokens") ?? num(total, "cached_input_tokens");
  const lastInput = last ? (num(last, "inputTokens") ?? num(last, "input_tokens")) : undefined;
  const lastTotal = last ? (num(last, "totalTokens") ?? num(last, "total_tokens")) : undefined;
  // Codex inputTokens already includes cachedInputTokens; last.totalTokens is the active context size.
  const contextTokens = lastTotal ?? lastInput;
  const window = num(holder, "modelContextWindow");
  return {
    inputTokens,
    outputTokens,
    ...(cached !== undefined ? { cacheReadTokens: cached } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(window !== undefined ? { contextWindow: window } : {}),
  };
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function protocolError(runId: string, ts: number, method: string, reason: string): AgentEvent {
  return { type: "error", runId, ts, message: `Malformed Codex notification ${method}: ${reason}`, fatal: false };
}

function fileChangeKind(value: unknown): "add" | "delete" | "rename" | "modify" {
  let name = "update";
  if (typeof value === "string") name = value;
  else if (value && typeof value === "object") name = String((value as Record<string, unknown>)["type"] ?? "update");
  if (name.startsWith("add")) return "add";
  if (name.startsWith("del")) return "delete";
  if (name.startsWith("ren")) return "rename";
  return "modify";
}

function incrementalToolUpdate(method: string, params: Record<string, unknown>): { input: unknown } | { progress: string } {
  if (method === "item/fileChange/patchUpdated") return { input: params["changes"] };
  if (method === "item/mcpToolCall/progress") return { progress: String(params["message"] ?? "") };
  return { progress: `Terminal input: ${String(params["stdin"] ?? "")}` };
}

function itemActivityStatus(started: boolean, failure: unknown, status: unknown): ActivityStatus {
  if (started) return "running";
  if (failure) return terminalStatus("failed");
  return terminalStatus(status);
}

function imageGenerationLabel(started: boolean, status: ActivityStatus): string {
  if (started) return "Generating image";
  if (status === "success") return "Generated image";
  return "Image generation";
}

function completedTurnStatus(status: unknown): "success" | "cancelled" | "error" {
  if (status === "completed") return "success";
  if (status === "interrupted") return "cancelled";
  return "error";
}

function terminalStatus(status: unknown): ActivityStatus {
  if (["failed", "declined", "denied", "blocked", "timedOut", "error"].includes(String(status))) return "error";
  if (["interrupted", "cancelled", "aborted", "stopped"].includes(String(status))) return "cancelled";
  return "success";
}
