import type { McpHost } from "@openorc/mcp";
import { TaskPriority } from "@openorc/protocol";
import type { ThreadService } from "../services/threads.js";
import type { RunContext } from "./context.js";
type Dependencies = { threadService: Pick<ThreadService, "toolCreate">; assertRunAvailable: RunContext["assertRunAvailable"] };
export function createTaskCreateHost({ threadService, assertRunAvailable }: Dependencies): McpHost["tasks"]["create"] {
  return (runId, input) => {
    assertRunAvailable(runId);
    return threadService.toolCreate(runId, {
      title: input.title,
      spec: input.spec,
      execution: input.execution,
      labels: input.labels,
      ...(input.workspaceMode ? { workspaceMode: input.workspaceMode } : {}),
      ...(input.priority ? { priority: TaskPriority.parse(input.priority) } : {}),
    });
  };
}
