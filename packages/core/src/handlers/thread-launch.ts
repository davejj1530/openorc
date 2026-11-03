import { ExecutableAgent, type RpcParams } from "@openorc/protocol";
import { ImportService } from "../services/imports.js";
import type { OrclingService } from "../services/orclings.js";
import { ThreadService } from "../services/threads.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  threadService: Pick<ThreadService, "implementPlan" | "exportPlan" | "start" | "update" | "switchClaudeAccount">;
  orclings: Pick<OrclingService, "startThread" | "threadPatch">;
  imports: Pick<ImportService, "import">;
};

/** A cloud conversation runs one model; Orclings start on this Mac. */
function assertCloudTarget(cloud: boolean | undefined, target: RpcParams<"threads.start">["executionTarget"]): void {
  if (cloud && target && target.kind !== "model") throw new Error("Cloud conversations run one model.");
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
      const selected = executionTarget?.settings;
      const executable = ExecutableAgent.parse(selected?.agent ?? agent);
      return threadService.start({
        projectId,
        claudeAccountId,
        ...(workingDirectory ? { workingDirectory } : {}),
        agent: executable,
        model: selected ? selected.model : model,
        effort: selected ? (selected.effort ?? undefined) : effort,
        fastMode: selected ? selected.fastMode : fastMode,
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
