import { z } from "zod";
import { ClaudeAccountId } from "./claude-accounts.js";
import { PermissionPreset, RunMode, WorkspaceMode } from "./domain.js";
import { AgentKind } from "./events.js";
import { ExecutionTarget } from "./execution-target.js";

/** Why a start that names its thread's id is refused: that thread exists. */
export const THREAD_EXISTS = "That conversation already exists.";

/** Creates the thread and starts its first turn in one step. */
export const ThreadStartParams = z
  .object({
    /**
     * The thread's id, chosen by the cloud brain's own Mac so its windows show the thread before the brain has it. Only
     * that Mac sets one; a phone's start with one is refused, and so is one naming a thread that exists.
     */
    id: z.string().uuid().optional(),
    claudeAccountId: ClaudeAccountId.optional(),
    projectId: z.string(),
    workingDirectory: z.string().min(1).max(4096).optional(),
    agent: AgentKind.optional(),
    executionTarget: ExecutionTarget.optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    fastMode: z.boolean().optional(),
    mode: RunMode,
    permissionMode: PermissionPreset,
    workspaceMode: WorkspaceMode.optional(),
    /** Runs the agent in a cloud sandbox; the thread's worktree on the Mac mirrors it. */
    cloud: z.boolean().optional(),
    baseRef: z.string().optional(),
    prompt: z.string().min(1),
    attachments: z.array(z.string()).optional(),
    title: z.string().optional(),
    /** Starts the thread under this one, in its folder, so a start that names it chooses no place of its own. */
    parentThreadId: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.parentThreadId && [input.id, input.workingDirectory, input.workspaceMode, input.cloud, input.baseRef].some((value) => value !== undefined)) {
      ctx.addIssue({ code: "custom", message: "A thread started under another works in its folder.", path: ["parentThreadId"] });
    }
    if (input.parentThreadId && input.executionTarget?.kind === "orcling") ctx.addIssue({ code: "custom", message: "An Orcling starts its own threads.", path: ["parentThreadId"] });
    if (!input.executionTarget && !input.agent) ctx.addIssue({ code: "custom", message: "Choose a model or an Orcling.", path: ["executionTarget"] });
    if (input.executionTarget && [input.agent, input.model, input.effort, input.fastMode].some((value) => value !== undefined)) {
      ctx.addIssue({ code: "custom", message: "Supply an execution target or legacy model settings, not both.", path: ["executionTarget"] });
    }
  });
