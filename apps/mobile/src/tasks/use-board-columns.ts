import { BOARD_COLUMNS, type BoardColumn } from "@openorc/protocol";
import { useRpc } from "../client";
import { useShares } from "../connection/use-shares";

const NO_COLUMNS: readonly BoardColumn[] = [];

/**
 * The columns a project's board keeps, in its order, read again when the Mac says its board changed. None for a board
 * of the statuses alone, and for a Mac from before boards, which is never asked.
 */
export function useBoardColumns(projectId: string | undefined): readonly BoardColumn[] {
  const shared = useShares(BOARD_COLUMNS) === true;
  return useRpc("board.columns", { projectId: projectId ?? "" }, { enabled: shared && Boolean(projectId) }).data ?? NO_COLUMNS;
}
