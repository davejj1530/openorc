import { CLOUD_ACCOUNT_ONLY, ExecutableAgent, type RpcParams } from "@openorc/protocol";
import { ImportService } from "../services/imports.js";
import type { OrclingService } from "../services/orclings.js";
import { ThreadService } from "../services/threads.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  threadService: Pick<ThreadService, "implementPlan" | "exportPlan" | "start" | "startUnder" | "update" | "switchClaudeAccount">;
  orclings: Pick<OrclingService, "startThread" | "threadPatch">;
  imports: Pick<ImportService, "import">;
};

/**
 * A start for OpenOrc Cloud reaches this Mac only signed out of it. One for the person's own cloud, which a phone build
 * from before its removal may still ask for, never gets here: the params take no `cloud`, so it is refused as invalid.
 */
function assertStartsHere({ hosted }: Pick<RpcParams<"threads.start">, "hosted">): void {
  if (hosted) throw new Error("Sign in to OpenOrc to start a thread on OpenOrc Cloud.");
}

/** The model a start runs on: its execution target's settings, or the separate fields older callers send. */
function modelSettings({ executionTarget, agent, model, effort, fastMode }: Pick<RpcParams<"threads.start">, "executionTarget" | "agent" | "model" | "effort" | "fastMode">) {
  const selected = executionTarget?.kind === "model" ? executionTarget.settings : undefined;
  if (!selected) return { agent: ExecutableAgent.parse(agent), model, effort, fastMode };
  return { agent: selected.agent, model: selected.model, effort: selected.effort ?? undefined, fastMode: selected.fastMode };
}

export function createThreadLaunchHandlers({
  threadService,
  orclings,
  imports,
}: Dependencies): Pick<Handlers, "threads.implementPlan" | "threads.exportPlan" | "threads.start" | "threads.update" | "threads.switchClaudeAccount" | "threads.import"> {
  return {
    "threads.implementPlan": ({ id, planId, permissionMode }) => threadService.implementPlan(id, planId, permissionMode),
    "threads.exportPlan": ({ id, planId, filename }) => threadService.exportPlan(id, planId, filename),
    "threads.start": ({
      id,
      projectId,
      workingDirectory,
      agent,
      model,
      effort,
      fastMode,
      claudeAccountId,
      executionTarget,
      mode,
      permissionMode,
      workspaceMode,
      hosted,
      baseRef,
      prompt,
      attachments,
      title,
      parentThreadId,
    }) => {
      assertStartsHere({ hosted });
      if (executionTarget?.kind === "orcling") {
        return orclings.startThread(executionTarget.orclingId, {
          projectId,
          claudeAccountId,
          mode,
          permissionMode,
          prompt,
          attachments,
          title,
          ...(workspaceMode ? { workspaceMode } : {}),
          ...(baseRef ? { baseRef } : {}),
        });
      }
      const settings = modelSettings({ executionTarget, agent, model, effort, fastMode });
      if (parentThreadId) return threadService.startUnder(parentThreadId, { claudeAccountId, ...settings, mode, permissionMode, prompt, attachments, title });
      return threadService.start({
        ...(id ? { id } : {}),
        projectId,
        claudeAccountId,
        ...(workingDirectory ? { workingDirectory } : {}),
        ...settings,
        mode,
        permissionMode,
        ...(workspaceMode ? { workspaceMode } : {}),
        ...(baseRef ? { baseRef } : {}),
        prompt,
        attachments,
        title,
      });
    },
    "threads.update": ({ id, patch: { cloudAccountId, ...patch } }) => {
      if (cloudAccountId !== undefined) throw new Error(CLOUD_ACCOUNT_ONLY);
      return threadService.update(id, orclings.threadPatch(id, patch));
    },
    "threads.switchClaudeAccount": ({ id, claudeAccountId }) => threadService.switchClaudeAccount(id, claudeAccountId),
    "threads.import": ({ projectId, sessions }) => imports.import(projectId, sessions),
  };
}
