import { type McpHost } from "@openorc/mcp";
import { AttachmentService } from "../services/attachments.js";
import { ThreadService } from "../services/threads.js";
import type { RunContext } from "./context.js";
import { onlineTasks, type OnlineTasksHost } from "./online-tasks.js";
type Dependencies = {
  threadService: Pick<ThreadService, "toolGet" | "toolStart" | "toolList" | "toolUpdate">;
  dataDir: string;
  assertRunAvailable: RunContext["assertRunAvailable"];
  online?: OnlineTasksHost;
};
/** This Mac's tasks for a run's agent; a call that names a cloud project is the online tools'. */
export function createTasksHost({ threadService, dataDir, assertRunAvailable, online = null }: Dependencies): Omit<McpHost["tasks"], "create"> {
  return {
    start: async (runId, id, options) => {
      assertRunAvailable(runId);
      if (options?.scope) return onlineTasks(online).start(runId, id, options.scope);
      const scoped = await threadService.toolGet(runId, id);
      if (!scoped) throw new Error("Task not found in this agent's project.");
      const images = await new AttachmentService(dataDir).forTask(scoped.spec ?? "");
      const task = await threadService.toolStart(runId, id, options?.workspaceMode);
      return images.length ? { ...task, message: `${task.message}\nTask images (open these paths):\n${images.join("\n")}` } : task;
    },
    list: async (runId, scope) => {
      assertRunAvailable(runId);
      if (scope) return onlineTasks(online).list(runId, scope);
      return threadService.toolList(runId);
    },
    get: async (runId, id, scope) => {
      assertRunAvailable(runId);
      if (scope) return onlineTasks(online).get(runId, id, scope);
      return threadService.toolGet(runId, id);
    },
    update: async (runId, id, patch) => {
      assertRunAvailable(runId);
      if (patch.scope) return onlineTasks(online).update(runId, id, { ...patch, scope: patch.scope });
      return threadService.toolUpdate(runId, id, patch);
    },
  };
}
