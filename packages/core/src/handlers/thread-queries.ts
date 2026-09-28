import { Db } from "@openorc/db";
import { ImportService } from "../services/imports.js";
import { threadTurnChanges } from "../services/thread-turn-changes.js";
import { ThreadService } from "../services/threads.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  threadService: Pick<ThreadService, "withCheckoutBranches" | "list" | "get" | "messages" | "plans" | "search" | "checkpoints">;
  db: Db;
  imports: Pick<ImportService, "importable">;
};

export function createThreadQueriesHandlers({
  threadService,
  db,
  imports,
}: Dependencies): Pick<Handlers, "threads.list" | "threads.get" | "threads.messages" | "threads.plans" | "threads.search" | "threads.checkpoints" | "threads.turnChanges" | "threads.importable"> {
  return {
    "threads.list": ({ projectId, projectsOnly, filter, limit, offset }) =>
      threadService.withCheckoutBranches(
        threadService.list({
          ...(projectId ? { projectId } : {}),
          ...(projectsOnly ? { projectsOnly } : {}),
          ...(filter ? { filter } : {}),
          ...(limit ? { limit } : {}),
          ...(offset ? { offset } : {}),
        }),
      ),
    "threads.get": async ({ id }) => {
      const thread = threadService.get(id);
      return thread ? (await threadService.withCheckoutBranches([thread]))[0]! : null;
    },
    "threads.messages": ({ id }) => threadService.messages(id),
    "threads.plans": ({ id }) => threadService.plans(id),
    "threads.search": ({ query, projectId, limit }) => threadService.search(query, { ...(projectId ? { projectId } : {}), ...(limit ? { limit } : {}) }),
    "threads.checkpoints": ({ id }) => threadService.checkpoints(id),
    "threads.turnChanges": ({ id, ...input }) => threadTurnChanges(db, { threadId: id, ...input }),
    "threads.importable": ({ projectId }) => imports.importable(projectId),
  };
}
