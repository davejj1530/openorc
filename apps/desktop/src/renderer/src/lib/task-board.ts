import type { BoardColumn, BoardColumnJob, BoardStage, TaskStatus } from "@openorc/protocol";
import { statusLabel } from "../components/status";
import { taskNeedsYou, type TaskRecord } from "./task-records";

/** A column as the project keeps it. One without an id is not saved yet. */
export type BoardSlot = { id?: string; name: string; stage: BoardStage; job?: BoardColumnJob | null; nextColumnId?: string | null; jobEnabled?: boolean };

/** One column of the board: the tasks at one stage of the work. A card dropped on it takes its stage. */
export type TaskBoardColumn = {
  id: string;
  name: string;
  stage: TaskStatus;
  /** Its place among the columns the project can change. Null for one the board draws only while it holds tasks. */
  slot: number | null;
  /** The project's own column, which a card is put in by its id. */
  kept: BoardColumn | null;
  /** How far round its mark's arc goes, when several columns hold work under way. */
  share?: number;
  tasks: TaskRecord[];
};

const stages: readonly TaskStatus[] = ["proposed", "backlog", "in_progress", "review", "done"];
const defaults: readonly BoardStage[] = ["backlog", "in_progress", "review", "done"];

const finishedAt = (record: TaskRecord): number => record.task.completedAt ?? record.task.updatedAt;

/** Cards keep their place while agents work: what waits on the person leads, then the newest task. Finished work reads latest first. */
function boardOrder(stage: TaskStatus): (a: TaskRecord, b: TaskRecord) => number {
  if (stage === "done") return (a, b) => finishedAt(b) - finishedAt(a);
  return (a, b) => Number(taskNeedsYou(b)) - Number(taskNeedsYou(a)) || b.task.createdAt - a.task.createdAt;
}

/** The columns a project can rename, add to, reorder and remove: its own, or one for each stage until it keeps some. */
export function boardSlots(kept: readonly BoardColumn[]): BoardSlot[] {
  return kept.length > 0
    ? kept.map(({ id, name, stage, job, nextColumnId, jobEnabled }) => ({ id, name, stage, job, nextColumnId, jobEnabled }))
    : defaults.map((stage) => ({ name: statusLabel[stage], stage }));
}

/**
 * The project's columns with their tasks. A task sits in the column it was put in, else in the first column of its
 * status. A status with tasks and no column, a proposal among them, gets a column for as long as it holds one, so
 * nothing leaves the board with its column.
 */
export function taskBoardColumns(tasks: readonly TaskRecord[], kept: readonly BoardColumn[] = []): TaskBoardColumn[] {
  const columns: TaskBoardColumn[] = boardSlots(kept).map((slot, index) => ({ id: slot.id ?? slot.stage, name: slot.name, stage: slot.stage, slot: index, kept: kept[index] ?? null, tasks: [] }));
  for (const stage of stages) {
    if (columns.some((column) => column.stage === stage) || !tasks.some((record) => record.task.status === stage)) continue;
    const next = columns.findIndex((column) => stages.indexOf(column.stage) > stages.indexOf(stage));
    columns.splice(next < 0 ? columns.length : next, 0, { id: stage, name: statusLabel[stage], stage, slot: null, kept: null, tasks: [] });
  }
  for (const record of tasks) {
    const own = record.kind === "local" && record.task.columnId ? columns.find((column) => column.kept?.id === record.task.columnId) : undefined;
    (own ?? columns.find((column) => column.stage === record.task.status))?.tasks.push(record);
  }
  const working = columns.filter((column) => column.stage === "in_progress");
  working.forEach((column, index) => {
    if (working.length > 1) column.share = (index + 1) / (working.length + 1);
  });
  for (const column of columns) column.tasks.sort(boardOrder(column.stage));
  return columns;
}
