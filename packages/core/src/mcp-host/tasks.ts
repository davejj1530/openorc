import { type McpHost } from "@openorc/mcp";
import { AttachmentService } from "../services/attachments.js";
import { ThreadService } from "../services/threads.js";
import type { RunContext } from "./context.js";
type Dependencies = {
  threadService: Pick<ThreadService, "toolGet" | "toolStart" | "toolList" | "toolUpdate">;
  dataDir: string;
  assertRunAvailable: RunContext["assertRunAvailable"];
};
export function createTasksHost({ threadService, dataDir, assertRunAvailable }: Dependencies): Omit<McpHost["tasks"], "create"> {
  return {
    start: async (runId, id, options) => {
      assertRunAvailable(runId);
      const scoped = await threadService.toolGet(runId, id);
      if (!scoped) throw new Error("Task not found in this agent's project.");
      const images = await new AttachmentService(dataDir).forTask(scoped.spec ?? "");
      const task = await threadService.toolStart(runId, id, options?.workspaceMode);
      return images.length ? { ...task, message: `${task.message}\nTask images (open these paths):\n${images.join("\n")}` } : task;
    },
    list: (runId) => {
      assertRunAvailable(runId);
      return threadService.toolList(runId);
    },
    get: (runId, id) => {
      assertRunAvailable(runId);
      return threadService.toolGet(runId, id);
    },
    update: (runId, id, patch) => {
      assertRunAvailable(runId);
      return threadService.toolUpdate(runId, id, patch);
    },
  };
}
