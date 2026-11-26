import { create } from "zustand";

const key = "openorc.tasks-view";

export type TasksView = "list" | "board";

/** The Tasks screen is a list until the person chooses its board. */
function read(): TasksView {
  try {
    return localStorage.getItem(key) === "board" ? "board" : "list";
  } catch {
    return "list";
  }
}

function save(view: TasksView): void {
  try {
    localStorage.setItem(key, view);
  } catch {
    // private mode; the choice lasts for this session only
  }
}

interface TasksViewState {
  view: TasksView;
  setView: (view: TasksView) => void;
}

/** How the Tasks screen lays its tasks out, kept across launches. */
export const useTasksView = create<TasksViewState>((set) => ({
  view: read(),
  setView(view) {
    save(view);
    set({ view });
  },
}));

window.addEventListener("storage", (event) => {
  if (event.key !== null && event.key !== key) return;
  useTasksView.setState({ view: read() });
});
