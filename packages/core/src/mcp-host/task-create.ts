import type { McpHost } from "@openorc/mcp";
import { TaskPriority } from "@openorc/protocol";
import type { ThreadService } from "../services/threads.js";
import type { RunContext } from "./context.js";
import { onlineTasks, type OnlineTasksHost } from "./online-tasks.js";
type Dependencies = { threadService: Pick<ThreadService, "toolCreate">; assertRunAvailable: RunContext["assertRunAvailable"]; online?: OnlineTasksHost; created: () => void };
export function createTaskCreateHost({ threadService, assertRunAvailable, online = null, created }: Dependencies): McpHost["tasks"]["create"] {
  return async (runId, input) => {
    assertRunAvailable(runId);
    if (input.scope) return onlineTasks(online).create(runId, { ...input, scope: input.scope });
    const made = await threadService.toolCreate(runId, {
      title: input.title,
      spec: input.spec,
      execution: input.execution,
      labels: input.labels,
      ...(input.workspaceMode ? { workspaceMode: input.workspaceMode } : {}),
      ...(input.priority ? { priority: TaskPriority.parse(input.priority) } : {}),
    });
    created();
    return made;
  };
}
