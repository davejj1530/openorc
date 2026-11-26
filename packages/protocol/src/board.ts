import { z } from "zod";
import { BoardStage, ThreadChoice } from "./domain.js";

/** Where a team board column's agent runs: on the computer of the task's assignee, or on OpenOrc Cloud as them. */
export const BoardJobPlace = z.enum(["computer", "cloud"]);
export type BoardJobPlace = z.infer<typeof BoardJobPlace>;

/**
 * What a board column has an agent do with a card put in it: the instructions, and the model when the person chose one.
 * Without one, the task's thread's. `where` is a team board's: absent, its agent runs on the assignee's computer.
 */
export const BoardColumnJob = z.object({ prompt: z.string().trim().min(1).max(8000), choice: ThreadChoice.nullable(), where: BoardJobPlace.optional() });
export type BoardColumnJob = z.infer<typeof BoardColumnJob>;
/** One column of a project's board, in the order the project keeps them. A project that keeps none has a column for each stage. */
export const BoardColumn = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  stage: BoardStage,
  /** The job a card starts when it is put in the column. */
  job: BoardColumnJob.nullable(),
  /** The column that job hands the card on to when its work is done, always one after this one. */
  nextColumnId: z.string().nullable(),
  /** Whether the job starts. Switched off, a card put here starts nothing. */
  jobEnabled: z.boolean(),
});
export type BoardColumn = z.infer<typeof BoardColumn>;

/** The most columns a board has. */
export const BOARD_COLUMNS_MAX = 12;

/** A project's whole board as it is saved, in order. A column without an id is new; a kept column left out is removed and its tasks stay in their stage. */
export const BoardColumnsSave = z
  .array(
    z.object({
      id: z.string().optional(),
      name: z.string().trim().min(1).max(40),
      stage: BoardStage,
      job: BoardColumnJob.nullable().optional(),
      nextColumnId: z.string().nullable().optional(),
      jobEnabled: z.boolean().optional(),
    }),
  )
  .min(1)
  .max(BOARD_COLUMNS_MAX);

export const boardRpcParams = {
  "board.columns": z.object({ projectId: z.string() }),
  /** Every project's own columns, each project's in its board's order, for a board of all projects. */
  "board.allColumns": z.object({}),
  /** Every column job, of one project or of all. */
  "board.jobs": z.object({ projectId: z.string().optional() }),
  "board.switchJob": z.object({ columnId: z.string(), enabled: z.boolean() }),
  /** Adds one of the app's ready-made board automations to a project: its task buttons, and its columns in their place. */
  "board.addReadyMade": z.object({ projectId: z.string(), id: z.string() }),
  "board.saveColumns": z.object({ projectId: z.string(), columns: BoardColumnsSave }),
};

export interface BoardRpcResults {
  /** The columns the project keeps; none when its board is the default one. */
  "board.columns": BoardColumn[];
  "board.allColumns": BoardColumn[];
  "board.saveColumns": BoardColumn[];
  "board.jobs": BoardColumn[];
  "board.switchJob": null;
  "board.addReadyMade": BoardColumn[];
}
