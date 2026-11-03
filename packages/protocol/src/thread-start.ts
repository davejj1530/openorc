import { z } from "zod";
import { ClaudeAccountId } from "./claude-accounts.js";
import { PermissionPreset, RunMode, WorkspaceMode } from "./domain.js";
import { AgentKind } from "./events.js";
import { ExecutionTarget } from "./execution-target.js";

/** Creates the thread and starts its first turn in one step. */
export const ThreadStartParams = z
  .object({
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
  })
  .strict()
  .superRefine((input, ctx) => {
    if (!input.executionTarget && !input.agent) ctx.addIssue({ code: "custom", message: "Choose a model or an Orcling.", path: ["executionTarget"] });
    if (input.executionTarget && [input.agent, input.model, input.effort, input.fastMode].some((value) => value !== undefined)) {
      ctx.addIssue({ code: "custom", message: "Supply an execution target or legacy model settings, not both.", path: ["executionTarget"] });
    }
  });
