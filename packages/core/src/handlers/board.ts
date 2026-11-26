import { boardColumns, projects, type Db } from "@openorc/db";
import type { Handlers } from "./types.js";

type Dependencies = { db: Db; invalidate: (keys: string[]) => void };

export function createBoardHandlers({ db, invalidate }: Dependencies): Pick<Handlers, "board.columns" | "board.saveColumns"> {
  return {
    "board.columns": ({ projectId }) => boardColumns.list(db, projectId),
    "board.saveColumns": ({ projectId, columns }) => {
      if (!projects.get(db, projectId)) throw new Error("This project is no longer available.");
      const saved = boardColumns.save(db, projectId, columns);
      // Tasks follow a column that changed stage or left the board.
      invalidate(["board", "tasks", "inbox"]);
      return saved;
    },
  };
}
