import { projects, tasks, type Db } from "@openorc/db";
import { AttachmentService } from "../services/attachments.js";
import type { TaskRefineService } from "../services/task-refine.js";
import type { ThreadService } from "../services/threads.js";
import type { Handlers } from "./types.js";

type Dependencies = {
  db: Db;
  refines: Pick<TaskRefineService, "get" | "start" | "stop" | "dismiss">;
  threadService: Pick<ThreadService, "taskThreadList" | "newTaskThread" | "runTaskButton">;
  dataDir: string;
};
type Methods = "tasks.refine.get" | "tasks.refine.start" | "tasks.refine.stop" | "tasks.refine.dismiss" | "tasks.threads" | "tasks.newThread" | "tasks.runButton";

export function createTaskWorkHandlers({ db, refines, threadService, dataDir }: Dependencies): Pick<Handlers, Methods> {
  return {
    "tasks.refine.get": ({ taskId }) => refines.get(taskId),
    "tasks.refine.start": (input) => refines.start(input),
    "tasks.refine.stop": async ({ taskId }) => {
      await refines.stop(taskId);
      return null;
    },
    "tasks.refine.dismiss": async ({ taskId }) => {
      await refines.dismiss(taskId);
      return null;
    },
    "tasks.threads": ({ taskId }) => threadService.taskThreadList(taskId),
    "tasks.newThread": ({ taskId, choice }) => threadService.newTaskThread(taskId, choice),
    "tasks.runButton": async ({ taskId, buttonId }) => {
      const task = tasks.get(db, taskId);
      if (!task) throw new Error("Task not found.");
      const button = projects.get(db, task.projectId)?.settings.taskButtons?.find((candidate) => candidate.id === buttonId);
      if (!button) throw new Error("That button was removed from this project.");
      const images = await new AttachmentService(dataDir).forTask(task.spec ?? "");
      return threadService.runTaskButton(taskId, button, images);
    },
  };
}
