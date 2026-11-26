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

/** A project's board asked to open with a column's settings, for the person to give that column an agent: the column named, else its first working one. */
export type AgentSetup = { projectId: string; columnId: string | null };

interface TasksViewState {
  view: TasksView;
  setView: (view: TasksView) => void;
  agentSetup: AgentSetup | null;
  setUpAgent: (setup: AgentSetup | null) => void;
}

/** How the Tasks screen lays its tasks out, kept across launches. */
export const useTasksView = create<TasksViewState>((set) => ({
  view: read(),
  setView(view) {
    save(view);
    set({ view });
  },
  agentSetup: null,
  setUpAgent: (agentSetup) => set({ agentSetup }),
}));

window.addEventListener("storage", (event) => {
  if (event.key !== null && event.key !== key) return;
  useTasksView.setState({ view: read() });
});
