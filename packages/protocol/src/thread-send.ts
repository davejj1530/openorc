import { z } from "zod";
import { ClaudeAccountId } from "./claude-accounts.js";
import { PermissionPreset, RunMode, WorkspaceMode } from "./domain.js";
import { AgentKind } from "./events.js";
import { OnlineTaskSendContext } from "./online-task-execution.js";

export const threadSendRpcParams = {
  /** Hold a message until the current turn ends, then send it. */
  "threads.queue": z.object({ id: z.string(), text: z.string().min(1), attachments: z.array(z.string()).optional(), requestKey: z.string().min(1).optional(), task: OnlineTaskSendContext.optional() }),
  "runs.start": z.object({
    task: OnlineTaskSendContext.optional(),
    executionTarget: z.never().optional(),
    taskId: z.string().optional(),
    workspaceMode: WorkspaceMode.optional(),
    threadId: z.string().optional(),
    agent: AgentKind,
    model: z.string().optional(),
    effort: z.string().optional(),
    fastMode: z.boolean().optional(),
    attachments: z.array(z.string()).optional(),
    mode: RunMode,
    permissionMode: PermissionPreset,
    prompt: z.string().min(1),
    resume: z.boolean().optional(),
    /** A conversation goes on with another Claude account: this turn and the next ones run there, resuming its session. */
    claudeAccountId: ClaudeAccountId.optional(),
    /** The id the prompt is recorded under, so a window that already shows it as sent sees the same message land. */
    messageId: z.string().min(1).max(100).optional(),
  }),
  "runs.send": z.object({
    runId: z.string(),
    /** The running turn the sender saw, when they are not at this Mac: an OpenOrc Cloud thread joins that turn or keeps the message for its author, never a later turn. */
    expectedTurnId: z.string().optional(),
    text: z.string().min(1),
    attachments: z.array(z.string()).optional(),
    messageId: z.string().min(1).max(100).optional(),
    task: OnlineTaskSendContext.optional(),
  }),
};
