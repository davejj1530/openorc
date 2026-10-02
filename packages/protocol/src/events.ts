import { z } from "zod";
import { HarnessId } from "./harness.js";
import { McpToolSource } from "./mcp-apps.js";

/**
 * The internal event model. Every adapter (Claude Code, Codex, ACP) maps its
 * native stream onto these events. The ledger stores them, the renderer draws
 * them, and the MCP server reads them back. Shapes follow ACP's vocabulary so
 * the future ACP adapter is a mapping, not a redesign.
 */

/** Every harness, plus the ACP kind reserved for adapters that do not exist yet. */
export const AgentKind = z.enum([...HarnessId.options, "acp"]);
export type AgentKind = z.infer<typeof AgentKind>;

export const ApprovalKind = z.enum(["tool", "command", "file_change", "permissions", "user_input"]);
export type ApprovalKind = z.infer<typeof ApprovalKind>;

export const ApprovalDecision = z.enum(["allow", "allow_for_run", "deny"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

/** What the user answered: a decision, plus answers when the agent asked questions. */
export interface ApprovalResolution {
  decision: ApprovalDecision;
  answers?: Record<string, string[]>;
  /** Told to the agent with a declined request, in place of the generic refusal. */
  message?: string;
}

export const RunStatus = z.enum(["success", "error", "cancelled", "max_turns", "budget_exceeded"]);
export type RunStatus = z.infer<typeof RunStatus>;

export const Usage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  /** What the provider session has cost so far, as the provider reports it: a running total that a resumed session continues, not one turn's share. */
  costUsd: z.number().nonnegative().optional(),
  /** How full the conversation is: tokens the model read on the latest turn, and its window when the agent reports one. */
  contextTokens: z.number().int().nonnegative().optional(),
  contextWindow: z.number().int().positive().optional(),
});
export type Usage = z.infer<typeof Usage>;

const base = {
  /** Assigned by the host before persistence and delivery; deduplicates hydration overlap. */
  eventId: z.string().optional(),
  runId: z.string(),
  ts: z.number(),
};

export const ActivityStatus = z.enum(["running", "success", "error", "cancelled", "disconnected"]);
export type ActivityStatus = z.infer<typeof ActivityStatus>;

/** What gets a failed activity going again: more usage, or signing the provider's CLI back in. */
export const ActivityRecovery = z.object({ kind: z.enum(["usage", "sign_in"]), provider: z.enum(["codex", "claude"]) });
export type ActivityRecovery = z.infer<typeof ActivityRecovery>;

/** A command the agent left running in the background, such as a dev server. It runs until it ends or is stopped. */
export const BackgroundCommand = z.object({ id: z.string(), description: z.string() });
export type BackgroundCommand = z.infer<typeof BackgroundCommand>;

export const AgentEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("plan.updated"), ...base, documentId: z.string(), text: z.string(), delta: z.boolean().optional(), complete: z.boolean().optional() }),
  z.object({
    type: z.literal("session.started"),
    ...base,
    agent: AgentKind,
    externalSessionId: z.string().nullable(),
    model: z.string().nullable(),
    capabilities: z.array(z.string()).optional(),
    /** Tool names the harness reported for the session, when it lists them. */
    tools: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal("message.delta"),
    ...base,
    messageId: z.string(),
    role: z.enum(["assistant", "user", "system"]),
    text: z.string(),
  }),
  z.object({
    type: z.literal("message.completed"),
    ...base,
    messageId: z.string(),
    role: z.enum(["assistant", "user", "system"]),
    text: z.string(),
    /** Files the user attached, as absolute paths under the app's attachments folder. */
    attachments: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal("thinking.started"),
    ...base,
    messageId: z.string(),
  }),
  z.object({
    type: z.literal("thinking.completed"),
    ...base,
    messageId: z.string(),
    text: z.string().optional(),
  }),
  /** Provider work that is neither a chat message nor an executable tool call. */
  z.object({
    type: z.literal("activity.updated"),
    ...base,
    activityId: z.string(),
    label: z.string(),
    status: ActivityStatus,
    text: z.string().optional(),
    detail: z.unknown().optional(),
    activityKind: z.literal("image_generation").optional(),
    recovery: ActivityRecovery.optional(),
    imagePath: z.string().optional(),
  }),
  z.object({
    type: z.literal("activity.delta"),
    ...base,
    activityId: z.string(),
    label: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("tool.output.delta"),
    ...base,
    toolCallId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("tool.updated"),
    ...base,
    toolCallId: z.string(),
    input: z.unknown().optional(),
    progress: z.string().optional(),
    mcp: McpToolSource.optional(),
  }),
  z.object({
    type: z.literal("thinking.delta"),
    ...base,
    messageId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("tool.started"),
    ...base,
    toolCallId: z.string(),
    name: z.string(),
    input: z.unknown(),
    parentToolCallId: z.string().nullable(),
    mcp: McpToolSource.optional(),
  }),
  z.object({
    type: z.literal("tool.completed"),
    ...base,
    toolCallId: z.string(),
    name: z.string(),
    output: z.unknown(),
    mcp: McpToolSource.optional(),
    isError: z.boolean(),
    status: ActivityStatus.optional(),
    input: z.unknown().optional(),
    /** Set on transcript pages, which leave large outputs out; the row loads its output when opened. */
    outputOmitted: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("file.changed"),
    ...base,
    path: z.string(),
    kind: z.enum(["add", "modify", "delete", "rename"]),
    diff: z.string().optional(),
  }),
  z.object({
    type: z.literal("approval.requested"),
    ...base,
    approvalId: z.string(),
    kind: ApprovalKind,
    toolName: z.string().optional(),
    input: z.unknown(),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal("approval.resolved"),
    ...base,
    approvalId: z.string(),
    decision: ApprovalDecision,
    message: z.string().optional(),
    answers: z.record(z.string(), z.array(z.string())).optional(),
  }),
  z.object({
    type: z.literal("usage.updated"),
    ...base,
    usage: Usage,
  }),
  /** A prompt was taken up. Both providers keep their process open between turns, and queued input can start a turn on its own. */
  z.object({
    type: z.literal("turn.started"),
    ...base,
    turnId: z.string(),
  }),
  /** One prompt answered. Codex threads and Claude sessions both have many. */
  z.object({
    type: z.literal("turn.completed"),
    ...base,
    turnId: z.string(),
    status: RunStatus,
    resultText: z.string().optional(),
    usage: Usage.optional(),
    durationMs: z.number().nonnegative(),
  }),
  /**
   * What the agent has running in the background, outliving the turn that started it. `running` counts work that
   * reports back, such as a subagent or workflow: the agent is at work until it does. `commands` lists commands, such
   * as a dev server, that run until they end or are stopped. Either can start a turn when it ends on its own. Each
   * event replaces the last; events recorded before `commands` existed counted commands in `running`.
   */
  z.object({
    type: z.literal("background.updated"),
    ...base,
    running: z.number().int().nonnegative(),
    commands: z.array(BackgroundCommand).optional(),
  }),
  /** The agent process is gone. Emitted exactly once per run. */
  z.object({
    type: z.literal("session.completed"),
    ...base,
    status: RunStatus,
    durationMs: z.number().nonnegative(),
    turns: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("error"),
    ...base,
    message: z.string(),
    fatal: z.boolean(),
  }),
  /**
   * Native payload passthrough. The core writes these to its provider log for
   * debugging rather than the ledger; the renderer ignores them.
   */
  z.object({
    type: z.literal("raw"),
    ...base,
    agent: AgentKind,
    payload: z.unknown(),
  }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;
export type AgentEventType = AgentEvent["type"];

/**
 * One bridge frame: everything that happened on a run since the previous
 * frame. The core process emits at most one frame per run per animation
 * frame, so the renderer never sees per-event traffic.
 */
export const Frame = z.object({
  runId: z.string(),
  seq: z.number().int().nonnegative(),
  events: z.array(AgentEvent),
});
export type Frame = z.infer<typeof Frame>;

/** Request from the core to launch a run. */
export const RunSpec = z.object({
  runId: z.string(),
  agent: AgentKind,
  cwd: z.string(),
  prompt: z.string(),
  mode: z.enum(["plan", "act"]).optional(),
  model: z.string().optional(),
  /** Reasoning effort as the agent names it (low, medium, high, xhigh, max). */
  effort: z.string().optional(),
  /** Request the provider’s faster, higher-cost service tier. Off by default. */
  fastMode: z.boolean().optional(),
  /** Absolute paths of images to hand the agent with the prompt. */
  attachments: z.array(z.string()).optional(),
  resumeSessionId: z.string().optional(),
  /** With resumeSessionId: continue as a new session that branches off the old one instead of appending to it. */
  forkSession: z.boolean().optional(),
  permissionMode: z.enum(["review", "trusted", "autonomous"]).default("trusted"),
  systemPromptAppendix: z.string().optional(),
  mcpUrl: z.string().url().optional(),
  /** App-created connection only. Never populate this from user MCP configuration. */
  internalMcp: z
    .object({
      serverName: z.string().regex(/^openorc_[a-f0-9]{32}$/),
      url: z.string().url(),
      toolNames: z.array(z.string()),
    })
    .optional(),
  maxTurns: z.number().int().positive().optional(),
  /** Load only the app's MCP server, not the user's own configured servers. */
  strictMcp: z.boolean().optional(),
  /**
   * The working folder holds code the user hasn't vetted, such as a pull request under review. The agent takes no
   * settings, hooks, plugins or MCP servers from it; only the user's own configuration applies.
   */
  untrustedCheckout: z.boolean().optional(),
});
export type RunSpec = z.infer<typeof RunSpec>;
