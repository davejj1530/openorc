import { boardColumns, projects, type Db } from "@openorc/db";
import type { BoardJobs } from "../services/board-jobs.js";
import type { TaskReports } from "../services/task-reports.js";
import type { Handlers } from "./types.js";

type Dependencies = { db: Db; invalidate: (keys: string[]) => void; reports: Pick<TaskReports, "answer">; jobs: Pick<BoardJobs, "list" | "switch" | "addReadyMade"> };

export function createBoardHandlers({
  db,
  invalidate,
  reports,
  jobs,
}: Dependencies): Pick<Handlers, "board.columns" | "board.saveColumns" | "board.jobs" | "board.switchJob" | "board.addReadyMade" | "tasks.answerUpdate"> {
  return {
    "board.columns": ({ projectId }) => boardColumns.list(db, projectId),
    "board.saveColumns": ({ projectId, columns }) => {
      if (!projects.get(db, projectId)) throw new Error("This project is no longer available.");
      const saved = boardColumns.save(db, projectId, columns);
      // Tasks follow a column that changed stage or left the board.
      invalidate(["board", "tasks", "inbox"]);
      return saved;
    },
    "board.jobs": ({ projectId }) => jobs.list(projectId),
    "board.switchJob": ({ columnId, enabled }) => {
      jobs.switch(columnId, enabled);
      return null;
    },
    "board.addReadyMade": ({ projectId, id }) => jobs.addReadyMade(projectId, id),
    "tasks.answerUpdate": ({ taskId, eventId, reply }) => {
      reports.answer(taskId, eventId, reply);
      return null;
    },
  };
}
