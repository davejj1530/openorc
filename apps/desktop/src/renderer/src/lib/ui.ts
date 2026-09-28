import { create } from "zustand";
import { useRouter } from "./router";

interface UiState {
  importProject: boolean;
  importSessions: { open: boolean; projectId?: string };
  palette: boolean;
  /** What the palette opens on: everything, or messages across threads. */
  paletteMode: "all" | "messages";
  /** Thread ids in the order the sidebar shows them, for ⌘1 to ⌘9 and next/previous. */
  threadOrder: string[];
  /** The thread a delete was asked for; one confirm dialog serves every menu. */
  deleteThreadId: string | null;
  teamMoveThreadId: string | null;
  /** The conversation whose move to or from a worktree is being confirmed. */
  moveThreadId: string | null;
  openNewTask: (projectId?: string, threadId?: string) => void;
  setImportProject: (open: boolean) => void;
  setImportSessions: (open: boolean, projectId?: string) => void;
  setPalette: (open: boolean, mode?: "all" | "messages") => void;
  setThreadOrder: (ids: string[]) => void;
  setDeleteThread: (id: string | null) => void;
  setTeamMoveThread: (id: string | null) => void;
  setMoveThread: (id: string | null) => void;
}

/** App-wide overlays. A store rather than App state so shortcuts, the palette, and autorun can open them. */
export const useUi = create<UiState>((set, get) => ({
  importProject: false,
  importSessions: { open: false },
  palette: false,
  paletteMode: "all",
  threadOrder: [],
  deleteThreadId: null,
  teamMoveThreadId: null,
  moveThreadId: null,
  setDeleteThread: (deleteThreadId) => set({ deleteThreadId }),
  setTeamMoveThread: (teamMoveThreadId) => set({ teamMoveThreadId }),
  setMoveThread: (moveThreadId) => set({ moveThreadId }),
  openNewTask: (projectId, threadId) => useRouter.getState().navigate({ view: "newtask", ...(projectId ? { projectId } : {}), ...(threadId ? { threadId } : {}) }),
  setImportProject: (importProject) => set({ importProject }),
  setImportSessions: (open, projectId) => set({ importSessions: { open, ...(projectId ? { projectId } : {}) } }),
  setPalette: (palette, mode) => set({ palette, paletteMode: mode ?? (palette ? get().paletteMode : "all") }),
  setThreadOrder: (ids) => {
    const current = get().threadOrder;
    if (current.length === ids.length && current.every((id, i) => id === ids[i])) return;
    set({ threadOrder: ids });
  },
}));
