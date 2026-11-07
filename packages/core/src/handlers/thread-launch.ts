import { ExecutableAgent, type RpcParams } from "@openorc/protocol";
import { ImportService } from "../services/imports.js";
import type { OrclingService } from "../services/orclings.js";
import { ThreadService } from "../services/threads.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  threadService: Pick<ThreadService, "implementPlan" | "exportPlan" | "start" | "startUnder" | "update" | "switchClaudeAccount">;
  orclings: Pick<OrclingService, "startThread" | "threadPatch">;
  imports: Pick<ImportService, "import">;
};

/** A cloud conversation runs one model; Orclings start on this Mac. */
function assertCloudTarget(cloud: boolean | undefined, target: RpcParams<"threads.start">["executionTarget"]): void {
  if (cloud && target && target.kind !== "model") throw new Error("Cloud conversations run one model.");
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
      cloud,
      baseRef,
      prompt,
      attachments,
      title,
      parentThreadId,
    }) => {
      assertCloudTarget(cloud, executionTarget);
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
        cloud,
        ...(baseRef ? { baseRef } : {}),
        prompt,
        attachments,
        title,
      });
    },
    "threads.update": ({ id, patch }) => threadService.update(id, orclings.threadPatch(id, patch)),
    "threads.switchClaudeAccount": ({ id, claudeAccountId }) => threadService.switchClaudeAccount(id, claudeAccountId),
    "threads.import": ({ projectId, sessions }) => imports.import(projectId, sessions),
  };
}
