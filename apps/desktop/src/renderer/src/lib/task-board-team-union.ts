import { useCallback, useMemo, useState } from "react";
import { boardSlots } from "./task-board";
import type { BoardSource } from "./task-board-source";
import { boardsFull, boardUnion, unionBoardColumns, unionChange, unionSlots, type ProjectBoard } from "./task-board-union";
import type { TaskRecord } from "./task-records";
import { useTaskOnlineMutation, useTaskOnlineQuery, type TaskOnlineScope } from "./task-online-query";

/** An organization's projects, whose shared boards the board of all its projects shows as their union. */
export type TeamUnionOwner = { place: "team-union"; scope: TaskOnlineScope; projectIds: readonly string[]; names: ReadonlyMap<string, string>; runs: boolean };

const CHANGED = "A project's board changed while you were editing it. It shows the latest columns now, so make your change again.";

/** Why the last save failed, or, after one lost to another person's, that the board now shows theirs. */
function teamNotice(state: { error: Error | null; lost: boolean }): { text: string; failed: boolean } | null {
  if (state.error) return { text: `Couldn’t save the board: ${state.error.message}`, failed: true };
  return state.lost ? { text: CHANGED, failed: false } : null;
}

/**
 * The board of all of an organization's projects: the union of their shared boards, read together, and its save, which
 * saves each project's board the change reaches from the revision it was read at. A save another person's overtook
 * stops there and reads the boards again. Only someone who may change every project's board may change the union.
 */
export function useTeamUnionBoard(owner: TeamUnionOwner | null): BoardSource {
  const read = useTaskOnlineQuery(owner?.scope ?? null, "tasks.online.boards", { spaceId: owner?.scope.spaceId ?? "", projectIds: [...(owner?.projectIds ?? [])] });
  const save = useTaskOnlineMutation(owner?.scope ?? null, "tasks.online.saveBoard");
  const [state, setState] = useState<{ saving: boolean; error: Error | null; lost: boolean }>({ saving: false, error: null, lost: false });
  const boards = useMemo<ProjectBoard[]>(() => (read.data ?? []).map((board) => ({ projectId: board.projectId, slots: boardSlots(board.columns), revision: board.revision })), [read.data]);
  const union = useMemo(() => boardUnion(boards), [boards]);
  const slots = useMemo(() => unionSlots(union), [union]);
  const columnsFor = useCallback((tasks: readonly TaskRecord[]) => unionBoardColumns(tasks, union, boards, "online"), [union, boards]);
  const run = async (next: Parameters<BoardSource["save"]>[0]) => {
    if (!owner) return;
    setState({ saving: true, error: null, lost: false });
    try {
      for (const board of unionChange(union, next, boards)) {
        const saved = await save.mutateAsync({ spaceId: owner.scope.spaceId, projectId: board.projectId, requestId: crypto.randomUUID(), ifRevision: board.revision ?? 0, columns: board.slots });
        if (saved.state === "conflict") return setState({ saving: false, error: null, lost: true });
      }
      setState({ saving: false, error: null, lost: false });
    } catch (error) {
      setState({ saving: false, error: error instanceof Error ? error : new Error(String(error)), lost: false });
    }
  };
  const editable = Boolean(read.data?.length && read.data.every((board) => board.mayEdit));
  return {
    ready: read.data !== undefined,
    slots,
    columnsFor,
    union,
    editable,
    full: boardsFull(boards),
    save: (next) => void run(next),
    saving: state.saving,
    notice: teamNotice(state),
  };
}
