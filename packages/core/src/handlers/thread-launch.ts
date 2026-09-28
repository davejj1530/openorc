import { ExecutableAgent, WORKSPACE_ID } from "@openorc/protocol";
import { ImportService } from "../services/imports.js";
import { TeamConversationService } from "../services/team-conversation.js";
import { ThreadService } from "../services/threads.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  threadService: Pick<ThreadService, "implementPlan" | "exportPlan" | "start" | "update">;
  teamConversations: Pick<TeamConversationService, "start">;
  imports: Pick<ImportService, "import">;
};

export function createThreadLaunchHandlers({
  threadService,
  teamConversations,
  imports,
}: Dependencies): Pick<Handlers, "threads.implementPlan" | "threads.exportPlan" | "threads.start" | "threads.update" | "threads.import"> {
  return {
    "threads.implementPlan": ({ id, planId, permissionMode }) => threadService.implementPlan(id, planId, permissionMode),
    "threads.exportPlan": ({ id, planId, filename }) => threadService.exportPlan(id, planId, filename),
    "threads.start": ({ projectId, workingDirectory, requestKey, agent, model, effort, fastMode, executionTarget, mode, permissionMode, workspaceMode, baseRef, prompt, attachments, title }) => {
      if (projectId === WORKSPACE_ID && executionTarget?.kind === "team") throw new Error("Saved teams belong to projects. Select a model for Workspace.");
      if (executionTarget?.kind === "team") return teamConversations.start({ projectId, requestKey, executionTarget, mode, permissionMode, workspaceMode, baseRef, prompt, attachments, title });
      const selected = executionTarget?.settings;
      const executable = ExecutableAgent.parse(selected?.agent ?? agent);
      return threadService.start({
        projectId,
        ...(workingDirectory ? { workingDirectory } : {}),
        agent: executable,
        model: selected ? selected.model : model,
        effort: selected ? (selected.effort ?? undefined) : effort,
        fastMode: selected ? selected.fastMode : fastMode,
        mode,
        permissionMode,
        ...(workspaceMode ? { workspaceMode } : {}),
        ...(baseRef ? { baseRef } : {}),
        prompt,
        attachments,
        title,
      });
    },
    "threads.update": ({ id, patch, taskId }) => threadService.update(id, patch, taskId ? { taskId } : {}),
    "threads.import": ({ projectId, sessions }) => imports.import(projectId, sessions),
  };
}
