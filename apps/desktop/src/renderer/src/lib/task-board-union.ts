import { BOARD_COLUMNS_MAX, type BoardColumn, type BoardColumnJob, type BoardStage, type TaskStatus } from "@openorc/protocol";
import { statusLabel } from "../components/status";
import { boardSlots, settleColumns, type BoardSlot, type TaskBoardColumn } from "./task-board";
import type { TaskRecord } from "./task-records";

/**
 * A board of all projects shows the union of their columns: columns with the same name are one column. Each project
 * keeps its own columns; a change made here is made in every project that has the column.
 */

/** A project's column inside a union column: its id, or null while the project keeps the default columns unsaved. */
export type UnionMember = { projectId: string; columnId: string | null };

export type UnionColumn = {
  /** The name every member's column has, in lower case without outer spaces. */
  key: string;
  name: string;
  stage: BoardStage;
  members: UnionMember[];
  /** The agent of the first member that has one, and the projects whose agent differs from it. */
  job: BoardColumnJob | null;
  jobEnabled: boolean;
  jobsDiffer: string[];
  /** The column the first member's agent hands its cards to, as a union key. */
  next: string | null;
  /** Whether it is some project's only column, which a board cannot be without. */
  sole: boolean;
};

/** One project's board as the union reads it: its own columns, or the four statuses while it keeps none. */
export type ProjectBoard = { projectId: string; slots: BoardSlot[] };

const stageRank: Record<BoardStage, number> = { backlog: 0, in_progress: 1, review: 2, done: 3 };
const statuses: readonly TaskStatus[] = ["proposed", "backlog", "in_progress", "review", "done"];

export const columnKey = (name: string): string => name.trim().toLowerCase();

/** Each project's board, from every project's saved columns: a project with none keeps the four statuses. */
export function projectBoards(projectIds: readonly string[], columns: readonly BoardColumn[]): ProjectBoard[] {
  return projectIds.map((projectId) => ({ projectId, slots: boardSlots(columns.filter((column) => column.projectId === projectId)) }));
}

const sameJob = (a: BoardColumnJob | null | undefined, b: BoardColumnJob | null | undefined): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The union of the boards' columns, ordered by stage, then by where they sit in their boards, then by first seen. */
export function boardUnion(boards: readonly ProjectBoard[]): UnionColumn[] {
  const found = new Map<string, UnionColumn & { place: number; seen: number }>();
  for (const board of boards) {
    board.slots.forEach((slot, index) => {
      const key = columnKey(slot.name);
      const place = board.slots.length > 1 ? index / (board.slots.length - 1) : 0;
      const member = { projectId: board.projectId, columnId: slot.id ?? null };
      const known = found.get(key);
      if (!known) {
        const next = slot.nextColumnId ? board.slots.find((each) => each.id === slot.nextColumnId) : undefined;
        found.set(key, {
          key,
          name: slot.name,
          stage: slot.stage,
          members: [member],
          job: slot.job ?? null,
          jobEnabled: slot.jobEnabled ?? true,
          jobsDiffer: [],
          next: next ? columnKey(next.name) : null,
          sole: board.slots.length === 1,
          place,
          seen: found.size,
        });
        return;
      }
      known.members.push(member);
      known.place = Math.min(known.place, place);
      known.sole ||= board.slots.length === 1;
      if (!known.job && slot.job) Object.assign(known, { job: slot.job, jobEnabled: slot.jobEnabled ?? true });
      else if (!sameJob(known.job, slot.job)) known.jobsDiffer.push(board.projectId);
    });
  }
  return [...found.values()].sort((a, b) => stageRank[a.stage] - stageRank[b.stage] || a.place - b.place || a.seen - b.seen).map(({ place: _place, seen: _seen, ...column }) => column);
}

/** The union as the column settings edit it: each column by its key, the agent's next column by its key too. */
export function unionSlots(union: readonly UnionColumn[]): BoardSlot[] {
  return union.map((column) => ({ id: column.key, name: column.name, stage: column.stage, job: column.job, nextColumnId: column.next, jobEnabled: column.jobEnabled }));
}

/** The column a project's task sits in: its own column, else its project's first column of its status. */
function cardColumn(record: TaskRecord, columns: readonly TaskBoardColumn[], boards: ReadonlyMap<string, ProjectBoard>): TaskBoardColumn | undefined {
  const task = record.task;
  if (record.kind === "local") {
    if (task.columnId) {
      const own = columns.find((column) => column.members?.get(task.projectId) === task.columnId);
      if (own) return own;
    }
    const first = boards.get(task.projectId)?.slots.find((slot) => slot.stage === task.status);
    if (first) return columns.find((column) => column.id === columnKey(first.name));
  }
  return columns.find((column) => column.stage === task.status);
}

/** The board of all projects: the union's columns, a column for a status with tasks and no column, each card in its project's column. */
export function unionBoardColumns(tasks: readonly TaskRecord[], union: readonly UnionColumn[], boards: readonly ProjectBoard[]): TaskBoardColumn[] {
  const columns: TaskBoardColumn[] = union.map((column, index) => ({
    id: column.key,
    name: column.name,
    stage: column.stage,
    slot: index,
    kept: null,
    members: new Map(column.members.map((member) => [member.projectId, member.columnId])),
    job: column.jobEnabled ? column.job : null,
    tasks: [],
  }));
  for (const stage of statuses) {
    if (columns.some((column) => column.stage === stage) || !tasks.some((record) => record.task.status === stage)) continue;
    const next = columns.findIndex((column) => statuses.indexOf(column.stage) > statuses.indexOf(stage));
    columns.splice(next < 0 ? columns.length : next, 0, { id: stage, name: statusLabel[stage], stage, slot: null, kept: null, tasks: [] });
  }
  const byProject = new Map(boards.map((board) => [board.projectId, board]));
  for (const record of tasks) cardColumn(record, columns, byProject)?.tasks.push(record);
  return settleColumns(columns);
}

/** Whether every project's board has as many columns as a board can, so none can take another. */
export const boardsFull = (boards: readonly ProjectBoard[]): boolean => boards.every((board) => board.slots.length >= BOARD_COLUMNS_MAX);

/** Where a new column goes in a project's board: before its first column of a later stage, else at its end. A full board takes none. */
function placeNew(slots: BoardSlot[], added: BoardSlot): BoardSlot[] {
  if (slots.length >= BOARD_COLUMNS_MAX) return slots;
  const at = slots.findIndex((slot) => stageRank[slot.stage] > stageRank[added.stage]);
  return at < 0 ? [...slots, added] : [...slots.slice(0, at), added, ...slots.slice(at)];
}

/** One union column's change, as it applies to each project's own column of that name. Only the fields changed here are changed there. */
function changedFields(before: UnionColumn, after: BoardSlot): Partial<BoardSlot> & { nextKey?: string | null } {
  const fields: Partial<BoardSlot> & { nextKey?: string | null } = {};
  if (after.name !== before.name) fields.name = after.name;
  if (after.stage !== before.stage) fields.stage = after.stage;
  if (!sameJob(after.job, before.job)) fields.job = after.job ?? null;
  if ((after.jobEnabled ?? true) !== before.jobEnabled) fields.jobEnabled = after.jobEnabled ?? true;
  if ((after.nextColumnId ?? null) !== before.next) fields.nextKey = after.nextColumnId ?? null;
  return fields;
}

/** A project's column given the changes: the next column found by its name among the project's later columns. */
function applyFields(slots: readonly BoardSlot[], index: number, fields: ReturnType<typeof changedFields>): BoardSlot {
  const { nextKey, ...rest } = fields;
  const slot = { ...slots[index]!, ...rest };
  if (nextKey !== undefined) slot.nextColumnId = slots.slice(index + 1).find((each) => each.id && columnKey(each.name) === nextKey)?.id ?? null;
  if (rest.job === null) slot.nextColumnId = null;
  return slot;
}

/**
 * Each project's board after a change made to the union: a column removed here goes from every project that has it, a
 * column changed here changes in every project that has it, and a column added here is added to every project with
 * room for it. Only the boards that change are answered.
 */
export function unionChange(union: readonly UnionColumn[], next: readonly BoardSlot[], boards: readonly ProjectBoard[]): ProjectBoard[] {
  const after = new Map(next.filter((slot) => slot.id).map((slot) => [slot.id!, slot]));
  const removed = new Set(union.filter((column) => !after.has(column.key)).map((column) => column.key));
  const changes = new Map(union.flatMap((column) => (after.has(column.key) ? [[column.key, changedFields(column, after.get(column.key)!)] as const] : [])));
  const added = next.filter((slot) => !slot.id);
  return boards.flatMap((board) => {
    let slots = board.slots.filter((slot) => !removed.has(columnKey(slot.name)));
    slots = slots.map((slot, index) => {
      const fields = changes.get(columnKey(slot.name));
      return fields && Object.keys(fields).length > 0 ? applyFields(slots, index, fields) : slot;
    });
    for (const slot of added) slots = placeNew(slots, { name: slot.name, stage: slot.stage, ...(slot.job ? { job: slot.job } : {}) });
    return JSON.stringify(slots) === JSON.stringify(board.slots) ? [] : [{ projectId: board.projectId, slots }];
  });
}
