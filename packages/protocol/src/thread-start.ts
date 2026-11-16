import { z } from "zod";
import { ClaudeAccountId } from "./claude-accounts.js";
import { PermissionPreset, RunMode, WorkspaceMode } from "./domain.js";
import { AgentKind } from "./events.js";
import { ExecutionTarget } from "./execution-target.js";
import { SpaceId } from "./spaces.js";

/** Why a start that names its thread's id is refused: that thread exists. */
export const THREAD_EXISTS = "That conversation already exists.";

/** Creates the thread and starts its first turn in one step. */
export const ThreadStartParams = z
  .object({
    /** The thread's id, when its starter chooses it. A phone's start with one is refused, and so is one naming a thread that exists. */
    id: z.string().uuid().optional(),
    claudeAccountId: ClaudeAccountId.optional(),
    projectId: z.string(),
    spaceId: SpaceId.optional(),
    /**
     * An OpenOrc Cloud start from this Mac's project folder carries the folder's work (cloud parity unit 5a): its commits
     * GitHub lacks and its changed and new files, never ignored ones, with `include` naming the held-back files to send
     * after all. Without it the thread starts from GitHub alone, as before.
     */
    macWork: z.object({ include: z.array(z.string().min(1).max(1024)).max(200) }).optional(),
    workingDirectory: z.string().min(1).max(4096).optional(),
    agent: AgentKind.optional(),
    executionTarget: ExecutionTarget.optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    fastMode: z.boolean().optional(),
    mode: RunMode,
    permissionMode: PermissionPreset,
    workspaceMode: WorkspaceMode.optional(),
    /** Starts the thread on OpenOrc Cloud, from the project's repository there; the Mac keeps no folder for it. */
    hosted: z.literal(true).optional(),
    baseRef: z.string().optional(),
    prompt: z.string().min(1),
    attachments: z.array(z.string()).optional(),
    /** A start on OpenOrc Cloud with files, sent again under the same id after a lost answer, is the same start. */
    requestId: z.uuid().optional(),
    title: z.string().optional(),
    /** Starts the thread under this one, in its folder, so a start that names it chooses no place of its own. */
    parentThreadId: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.parentThreadId && [input.id, input.workingDirectory, input.workspaceMode, input.baseRef].some((value) => value !== undefined)) {
      ctx.addIssue({ code: "custom", message: "A thread started under another works in its folder.", path: ["parentThreadId"] });
    }
    if (input.hosted && [input.id, input.workingDirectory, input.workspaceMode, input.baseRef, input.parentThreadId].some((value) => value !== undefined)) {
      ctx.addIssue({ code: "custom", message: "A thread on OpenOrc Cloud works in its own sandbox there.", path: ["hosted"] });
    }
    if (input.hosted && input.executionTarget && input.executionTarget.kind !== "model") ctx.addIssue({ code: "custom", message: "OpenOrc Cloud runs one model.", path: ["hosted"] });
    if (input.parentThreadId && input.executionTarget?.kind === "orcling") ctx.addIssue({ code: "custom", message: "An Orcling starts its own threads.", path: ["parentThreadId"] });
    if (!input.executionTarget && !input.agent) ctx.addIssue({ code: "custom", message: "Choose a model or an Orcling.", path: ["executionTarget"] });
    if (input.executionTarget && [input.agent, input.model, input.effort, input.fastMode].some((value) => value !== undefined)) {
      ctx.addIssue({ code: "custom", message: "Supply an execution target or legacy model settings, not both.", path: ["executionTarget"] });
    }
  });
