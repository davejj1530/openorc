import { randomUUID } from "node:crypto";
import { BoardStage, OnlineBoardUpdate, type BoardColumn, type OnlineBoard, type OnlineTaskHistoryEntry, type OnlineTaskPatch, type TaskStatus } from "@openorc/protocol";
import type { TaskFixtureRecord } from "./stand-in-task-data.js";

type Reply = { status: number; body: unknown };
/** A board as kept; who may change it is the asker's, added as it is answered. */
type Kept = Omit<OnlineBoard, "mayEdit">;
type Column = OnlineTaskHistoryEntry["column"];
/** What the board does to a task as it saves: the task's fields, and its history entry. */
type Moved = (
  record: TaskFixtureRecord,
  change: { status?: TaskStatus; columnId: string | null },
  kind: OnlineTaskHistoryEntry["kind"],
  changes: OnlineTaskHistoryEntry["changes"],
  column?: Column,
) => void;

/**
 * Each project's shared board as the server keeps it: the columns in order and a revision each save moves on. A save
 * from an older revision changes nothing and answers the board as it is. The rules for a task's place are the server's:
 * a named column gives its stage as the status, and a status set by itself goes to the first column of that stage.
 */
export class StandInBoards {
  readonly #boards = new Map<string, Kept>();

  board(spaceId: string, projectId: string): Kept {
    return this.#boards.get(`${spaceId}:${projectId}`) ?? { revision: 0, columns: [] };
  }
  /** Saves the whole board, or answers a conflict when `body` names an older revision. `mayEdit` is the asker's, answered with the board. */
  save(spaceId: string, projectId: string, body: unknown, tasks: readonly TaskFixtureRecord[], moved: Moved, mayEdit: boolean): Reply {
    const parsed = OnlineBoardUpdate.safeParse(body);
    const named = parsed.success ? parsed.data.columns.flatMap((column) => (column.id ? [column.id] : [])) : [];
    if (!parsed.success || new Set(named).size !== named.length) return { status: 400, body: { message: "Check the board's columns." } };
    const board = this.board(spaceId, projectId);
    if (parsed.data.ifRevision !== board.revision) return { status: 200, body: { state: "conflict", ...board, mayEdit } };
    const kept = new Map(board.columns.map((column) => [column.id, column]));
    const ids = parsed.data.columns.map((column) => (column.id && kept.has(column.id) ? column.id : randomUUID()));
    const inColumn = (id: string) => tasks.filter((record) => record.task.columnId === id);
    for (const column of kept.values()) {
      if (!ids.includes(column.id)) for (const record of inColumn(column.id)) moved(record, { columnId: null }, "edited", {}, { before: column.name, after: null });
    }
    const columns: BoardColumn[] = parsed.data.columns.map((column, position) => {
      const id = ids[position]!;
      const before = kept.get(id);
      if (before && before.stage !== column.stage) {
        for (const record of inColumn(id)) moved(record, { status: column.stage, columnId: id }, "status_changed", { status: { before: record.task.status, after: column.stage } });
      }
      return { id, projectId, name: column.name, stage: column.stage, job: column.job ?? null, nextColumnId: null, jobEnabled: column.jobEnabled ?? true };
    });
    // A column hands work on only to one after it.
    parsed.data.columns.forEach((column, position) => {
      const next = column.nextColumnId ? ids.indexOf(column.nextColumnId) : -1;
      if (next > position) columns[position]!.nextColumnId = ids[next]!;
    });
    const saved = { revision: board.revision + 1, columns };
    this.#boards.set(`${spaceId}:${projectId}`, saved);
    return { status: 200, body: { state: "saved", ...saved, mayEdit } };
  }
  /** Where a person's change puts the task: a column with its stage, or a status in the first column of that stage. Null when the column is gone. */
  place(task: TaskFixtureRecord["task"], patch: Pick<OnlineTaskPatch, "status" | "columnId">): { status: TaskStatus; columnId: string | null } | null {
    const columns = this.board(task.spaceId, task.projectId).columns;
    if (patch.columnId !== undefined) {
      const column = columns.find((each) => each.id === patch.columnId);
      return column ? { status: column.stage, columnId: column.id } : null;
    }
    const current = { status: task.status, columnId: task.columnId ?? null };
    if (patch.status === undefined || patch.status === task.status) return current;
    const stage = BoardStage.safeParse(patch.status);
    return { status: patch.status, columnId: stage.success ? (columns.find((column) => column.stage === stage.data)?.id ?? null) : null };
  }
  /** The names a move between two columns is kept in history by, or nothing when the task stays. */
  change(task: TaskFixtureRecord["task"], before: string | null, after: string | null): Column {
    if (before === after) return undefined;
    const name = (id: string | null) => (id ? (this.board(task.spaceId, task.projectId).columns.find((column) => column.id === id)?.name ?? null) : null);
    return { before: name(before), after: name(after) };
  }
}
