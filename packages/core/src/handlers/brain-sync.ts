import { memoryChangesSince, projects, settings, tasks, type Db } from "@openorc/db";
import type { BoardTask, MacBacklog, Task, TaskBoard } from "@openorc/protocol";
import { OPEN_TASKS } from "../services/brain-sync.js";
import type { MemoryService } from "../services/memory.js";
import type { TextGenerationService } from "../services/text-generation.js";
import type { Handlers } from "./types.js";

const BRAIN_ONLY = "Only a cloud brain follows a Mac's memory, tasks and choices.";
const MAC_BACKLOG = "mac.backlog";

/** The Mac's open tasks as this brain last heard them; null before it heard any. */
export function macBacklog(db: Db): MacBacklog | null {
  try {
    return JSON.parse(settings.get(db, MAC_BACKLOG) ?? "null") as MacBacklog | null;
  } catch {
    return null;
  }
}

const onBoard = ({ id, projectId, title, status, priority, threadId, executionThreadId, updatedAt }: Task): BoardTask => ({
  id,
  projectId,
  title,
  status,
  priority,
  threadId,
  executionThreadId,
  updatedAt,
});

/** What a phone's task list shows of this host: its open tasks, and a brain's copy of its Mac's. */
export function taskBoard(db: Db, brain: boolean): TaskBoard {
  const mac = brain ? macBacklog(db) : null;
  return { tasks: tasks.list(db, { statuses: OPEN_TASKS }).map(onBoard), mac: mac && { at: mac.at, tasks: mac.tasks.map(onBoard) } };
}

type Dependencies = {
  db: Db;
  memory: Pick<MemoryService, "follow" | "merge">;
  textGeneration: Pick<TextGenerationService, "follow">;
  cloudOnly: boolean;
  invalidate: (keys: string[]) => void;
};

/** A cloud brain's side of what its Mac sends while both are awake. A Mac refuses them. */
export function createBrainSyncHandlers({ db, memory, textGeneration, cloudOnly, invalidate }: Dependencies): Pick<Handlers, "brain.memory.exchange" | "brain.backlog" | "brain.textGeneration"> {
  return {
    "brain.memory.exchange": async ({ projects: asked, ...choice }) => {
      if (!cloudOnly) throw new Error(BRAIN_ONLY);
      await memory.follow(choice);
      return {
        projects: asked
          .filter((each) => projects.get(db, each.projectId))
          .map(({ projectId, since, rows, removed }) => {
            const { kept } = memory.merge(projectId, { rows, removed });
            const mine = memoryChangesSince(db, projectId, since);
            return { projectId, next: mine.next, more: mine.more, rows: [...mine.rows, ...kept], removed: mine.removed };
          }),
      };
    },
    "brain.backlog": ({ at, tasks }) => {
      if (!cloudOnly) throw new Error(BRAIN_ONLY);
      settings.set(db, MAC_BACKLOG, JSON.stringify({ at, tasks } satisfies MacBacklog));
      invalidate(["tasks"]);
      return null;
    },
    "brain.textGeneration": (choice) => {
      if (!cloudOnly) throw new Error(BRAIN_ONLY);
      textGeneration.follow(choice);
      return null;
    },
  };
}
