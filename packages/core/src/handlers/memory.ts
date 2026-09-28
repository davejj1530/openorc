import { Db, tasks } from "@openorc/db";
import { MemoryService } from "../services/memory.js";
import { promoteMemory } from "./context.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  memory: Pick<MemoryService, "list" | "searchSaved" | "summariesForTask" | "record" | "update" | "feedback" | "remove" | "settings" | "updateSettings">;
  db: Db;
};

export function createMemoryHandlers({
  memory,
  db,
}: Dependencies): Pick<
  Handlers,
  "memory.list" | "memory.search" | "memory.forTask" | "memory.record" | "memory.update" | "memory.feedback" | "memory.remove" | "memory.promote" | "memory.settings.get" | "memory.settings.set"
> {
  return {
    "memory.list": ({ projectId, ...filters }) => memory.list(projectId, filters),
    "memory.search": async ({ projectId, query, limit }) => (await memory.searchSaved(projectId, query, limit ?? 12)).map((h) => h.memory),
    "memory.forTask": ({ taskId }) => {
      const task = tasks.get(db, taskId);
      const list = task ? memory.list(task.projectId, { taskId, statuses: ["active", "superseded"] }) : [];
      return { memories: list, summaries: memory.summariesForTask(taskId) };
    },
    "memory.record": ({ projectId, type, title, body, topicKey }) => memory.record({ projectId, type, title, body, topicKey: topicKey ?? null, source: "user" }),
    "memory.update": ({ id, patch }) => memory.update(id, patch),
    "memory.feedback": ({ id, verdict }) => memory.feedback(id, verdict),
    "memory.remove": ({ id }) => {
      memory.remove(id);
      return null;
    },
    "memory.promote": async ({ id, file }) => promoteMemory(db, id, file),
    "memory.settings.get": () => memory.settings(),
    "memory.settings.set": (patch) => memory.updateSettings(patch),
  };
}
