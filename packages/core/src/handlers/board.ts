import { boardColumns, projects, type Db } from "@openorc/db";
import type { TaskReports } from "../services/task-reports.js";
import type { Handlers } from "./types.js";

type Dependencies = { db: Db; invalidate: (keys: string[]) => void; reports: Pick<TaskReports, "answer"> };

export function createBoardHandlers({ db, invalidate, reports }: Dependencies): Pick<Handlers, "board.columns" | "board.saveColumns" | "tasks.answerUpdate"> {
  return {
    "board.columns": ({ projectId }) => boardColumns.list(db, projectId),
    "board.saveColumns": ({ projectId, columns }) => {
      if (!projects.get(db, projectId)) throw new Error("This project is no longer available.");
      const saved = boardColumns.save(db, projectId, columns);
      // Tasks follow a column that changed stage or left the board.
      invalidate(["board", "tasks", "inbox"]);
      return saved;
    },
    "tasks.answerUpdate": ({ taskId, eventId, reply }) => {
      reports.answer(taskId, eventId, reply);
      return null;
    },
  };
}
