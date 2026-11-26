import type { OpenOrc } from "../openorc.js";
import type { LedgerUpkeep } from "../services/ledger-upkeep.js";
import type { Logger } from "../transport.js";
import { createAutomationHandlers } from "./automations.js";
import { createBoardHandlers } from "./board.js";
import { createTaskCreateHandlers } from "./task-create.js";
import { createTaskDeleteHandlers } from "./task-delete.js";
import { createTaskQueriesHandlers } from "./task-queries.js";
import { createTaskUpdateHandlers } from "./task-update.js";
import { createTaskWorkHandlers } from "./task-work.js";
import { createWorkspaceHandlers } from "./workspace.js";

/** The services a task's calls are answered from, and the few things only the core itself holds. */
type Core = Pick<OpenOrc, "db" | "settings" | "threads" | "runs" | "comments" | "refines" | "workspaces" | "workspaceWriters" | "taskAutomation">;
type Own = { dataDir: string; upkeep: LedgerUpkeep; log: Logger; invalidate: (keys: string[]) => void };

/** Every call about a project's tasks: reading them, making, changing and deleting them, their work and its folder, their board and their automations. */
export function createTaskHandlers(core: Core, { dataDir, upkeep, log, invalidate }: Own) {
  const { db, settings, threads, runs, comments, refines, workspaces, workspaceWriters } = core;
  const { reports, board, rules, here } = core.taskAutomation;
  return {
    ...createTaskQueriesHandlers({ db, comments, threadService: threads, runService: runs }),
    ...createTaskWorkHandlers({ db, refines, threadService: threads, dataDir }),
    ...createTaskCreateHandlers({ db, settings, threadService: threads, invalidate, dataDir, created: () => rules.nudge() }),
    ...createTaskUpdateHandlers({ threadService: threads, db, runService: runs, workspaceWriters, workspaces, boardJobs: board, invalidate }),
    ...createTaskDeleteHandlers({ workspaces, comments, refines, runService: runs, db, log, upkeep, invalidate }),
    ...createWorkspaceHandlers({ runService: runs, workspaces, db, invalidate }),
    ...createBoardHandlers({ db, invalidate, reports, jobs: board }),
    ...createAutomationHandlers({ automations: rules }),
    "tasks.online.openHere": ({ spaceId, id }: { spaceId: string; id: string }) => here.open(spaceId, id),
  };
}
