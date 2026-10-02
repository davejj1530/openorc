import { create } from "zustand";
import { WORKSPACE_ID } from "@openorc/protocol";
import type { RpcParams } from "@openorc/protocol";
import type { FileReference } from "../../../shared/file-reference";
import type { PanelTool } from "./panel-tabs";

export type PanelTab = "orcling" | "plan" | "file" | "changes" | "tasks" | "task" | "terminal" | "browser" | "commits" | "checkpoints" | "memory" | "instructions";
/** One turn's saved diff, opened from its change card: a team attempt's checkpoint or a thread turn's. */
export type ChangeSelection = ({ kind: "team" } & Omit<RpcParams<"orchestration.turnChanges">, "includePatch">) | ({ kind: "thread" } & Omit<RpcParams<"threads.turnChanges">, "includePatch">);
export type FileSelection = FileReference & { scope: RpcParams<"files.read">["scope"] };
export type WorkspaceChangesTarget = { kind: "thread" | "project"; id: string };
export type WorkspaceChangesRequest = WorkspaceChangesTarget & { comparison: "base" | "head"; commit: boolean; requestId: number };

/** Which threads the sidebar lists: the working set or the archive. */
export type SidebarFilter = "active" | "archived";

/** A screen the sidebar can list. The ones the user hides wait under More; Inbox sits in the window's header instead. */
export type SidebarScreen = "tasks" | "pulls" | "scheduled" | "orchestration" | "memory";

/** Screens most people open rarely start under More, until the user lists them. */
const DEFAULT_HIDDEN_SCREENS: SidebarScreen[] = ["scheduled", "memory"];

interface LayoutState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  panelOpen: boolean;
  panelWidth: number;
  panelTab: PanelTab;
  selectedChanges: ChangeSelection | null;
  openChanges: (selection: ChangeSelection) => void;
  clearChanges: () => void;
  workspaceChanges: WorkspaceChangesRequest | null;
  openWorkspaceChanges: (target: WorkspaceChangesTarget, action?: "review" | "commit", comparison?: "base" | "head") => void;
  consumeWorkspaceCommit: (requestId: number) => void;
  selectedFile: FileSelection | null;
  openFile: (file: FileSelection) => void;
  /** The navigation scope for tasks, memory, and new threads. Null selects all projects. */
  projectId: string | null;
  /** The visible thread whose controls last opened the shared panel. */
  panelThreadId: string | null;
  toggleThreadPanel: (id: string) => void;
  openThreadPanel: (id: string, tab: PanelTab) => void;
  sidebarFilter: SidebarFilter;
  /** Screens the sidebar leaves under More. */
  hiddenScreens: SidebarScreen[];
  /** Sidebar sections the user folded: namespaced project/pinned keys, plus opt-in snoozed-open keys. */
  collapsed: string[];
  /**
   * Where each surface's preview was last pointed, keyed the way the panel
   * keys its panes. A dev server's port belongs to the project, not to us, so
   * the only honest default is the one the reader already chose here.
   */
  previewUrls: Record<string, string>;
  /** Tools opened in each panel scope, keyed like previewUrls, so their tabs stay for that thread. */
  panelTools: Record<string, PanelTool[]>;
  /** The preview fills the work row. Never persisted: a relaunch opens the panel at its width. */
  panelExpanded: boolean;
  toggleSidebar: () => void;
  setSidebarWidth: (px: number) => void;
  setPanel: (open: boolean, tab?: PanelTab) => void;
  setPanelWidth: (px: number) => void;
  setProject: (id: string | null) => void;
  setSidebarFilter: (filter: SidebarFilter) => void;
  setScreenShown: (screen: SidebarScreen, shown: boolean) => void;
  toggleCollapsed: (key: string) => void;
  rememberPreviewUrl: (key: string, url: string) => void;
  rememberPanelTool: (key: string, tool: PanelTool) => void;
  setPanelExpanded: (expanded: boolean) => void;
}

export const limits = {
  sidebar: { min: 224, max: 380, default: 288 },
  panel: { min: 340, max: 900, default: 460 },
};

const KEY = "openorc.layout";

function read(): Partial<
  Pick<LayoutState, "sidebarOpen" | "sidebarWidth" | "panelOpen" | "panelWidth" | "panelTab" | "projectId" | "sidebarFilter" | "hiddenScreens" | "collapsed" | "previewUrls" | "panelTools">
> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<LayoutState>;
  } catch {
    return {};
  }
}

function persist(s: LayoutState): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        sidebarOpen: s.sidebarOpen,
        sidebarWidth: s.sidebarWidth,
        panelOpen: s.panelOpen,
        panelWidth: s.panelWidth,
        panelTab: s.panelTab,
        projectId: s.projectId,
        sidebarFilter: s.sidebarFilter,
        hiddenScreens: s.hiddenScreens,
        collapsed: s.collapsed,
        previewUrls: s.previewUrls,
        panelTools: s.panelTools,
      }),
    );
  } catch {
    // private mode; the layout lives for this session only
  }
}

/** Widths reach the DOM as CSS variables so a drag never re-renders React. */
export function applyWidths(sidebar: number, panel: number): void {
  const root = document.documentElement.style;
  root.setProperty("--layout-sidebar", `${Math.round(sidebar)}px`);
  root.setProperty("--layout-panel", `${Math.round(panel)}px`);
}

const clamp = (v: number, { min, max }: { min: number; max: number }) => Math.min(max, Math.max(min, v));

/** The three-column frame: sidebar, main, and an optional panel. Sizes persist across launches. */
export const useLayout = create<LayoutState>((set, get) => {
  const saved = read();
  const initial = {
    sidebarOpen: saved.sidebarOpen ?? true,
    sidebarWidth: clamp(saved.sidebarWidth ?? limits.sidebar.default, limits.sidebar),
    panelOpen: saved.panelOpen ?? false,
    panelWidth: clamp(saved.panelWidth ?? limits.panel.default, limits.panel),
    panelTab: saved.panelTab ?? ("changes" as PanelTab),
    selectedFile: null,
    selectedChanges: null,
    workspaceChanges: null,
    projectId: saved.projectId === undefined ? WORKSPACE_ID : saved.projectId,
    panelThreadId: null,
    sidebarFilter: saved.sidebarFilter === "archived" ? ("archived" as const) : ("active" as const),
    hiddenScreens: saved.hiddenScreens ?? DEFAULT_HIDDEN_SCREENS,
    collapsed: saved.collapsed ?? ["snoozed"],
    previewUrls: saved.previewUrls ?? {},
    panelTools: saved.panelTools ?? {},
    panelExpanded: false,
  };
  applyWidths(initial.sidebarWidth, initial.panelWidth);
  const commit = (patch: Partial<LayoutState>) => {
    set(patch);
    const s = get();
    persist(s);
    applyWidths(s.sidebarWidth, s.panelWidth);
  };
  return {
    ...initial,
    toggleSidebar: () => commit({ sidebarOpen: !get().sidebarOpen }),
    setSidebarWidth: (px) => commit({ sidebarWidth: clamp(px, limits.sidebar) }),
    setPanel: (open, tab) => commit({ panelOpen: open, ...(tab ? { panelTab: tab } : {}), ...(open ? {} : { panelExpanded: false }) }),
    openChanges: (selectedChanges) => {
      let threadSelection: Partial<Pick<LayoutState, "panelThreadId">> = {};
      if (selectedChanges.kind === "thread") threadSelection = { panelThreadId: selectedChanges.id };
      else if (!selectedChanges.taskId) threadSelection = { panelThreadId: selectedChanges.threadId };
      commit({
        selectedChanges,
        panelOpen: true,
        panelTab: "changes",
        ...threadSelection,
      });
    },
    clearChanges: () => set({ selectedChanges: null }),
    openWorkspaceChanges: (target, action = "review", comparison = "head") =>
      commit({
        workspaceChanges: { ...target, comparison, commit: action === "commit", requestId: (get().workspaceChanges?.requestId ?? 0) + 1 },
        selectedChanges: null,
        panelOpen: true,
        panelTab: "changes",
        panelThreadId: target.kind === "thread" ? target.id : null,
      }),
    consumeWorkspaceCommit: (requestId) => {
      const request = get().workspaceChanges;
      if (request?.requestId === requestId) set({ workspaceChanges: { ...request, commit: false } });
    },
    openFile: (selectedFile) => commit({ selectedFile, panelOpen: true, panelTab: "file", ...(selectedFile.scope.kind === "thread" ? { panelThreadId: selectedFile.scope.id } : {}) }),
    setPanelWidth: (px) => commit({ panelWidth: clamp(px, limits.panel) }),
    setProject: (projectId) => commit({ projectId }),
    openThreadPanel: (id, tab) => commit({ panelThreadId: id, panelOpen: true, panelTab: tab }),
    toggleThreadPanel: (id) => {
      const open = get().panelThreadId !== id || !get().panelOpen;
      commit({ panelThreadId: id, panelOpen: open, ...(open ? {} : { panelExpanded: false }) });
    },
    setSidebarFilter: (sidebarFilter) => commit({ sidebarFilter }),
    setScreenShown: (screen, shown) => {
      const others = get().hiddenScreens.filter((hidden) => hidden !== screen);
      commit({ hiddenScreens: shown ? others : [...others, screen] });
    },
    toggleCollapsed: (key) => commit({ collapsed: get().collapsed.includes(key) ? get().collapsed.filter((k) => k !== key) : [...get().collapsed, key] }),
    // Bounded because the key is a surface id and threads are unbounded; the
    // oldest entries are the ones whose thread the reader has stopped opening.
    rememberPreviewUrl: (key, url) => {
      const kept = Object.entries(get().previewUrls)
        .filter(([k]) => k !== key)
        .slice(-49);
      commit({ previewUrls: Object.fromEntries([...kept, [key, url]]) });
    },
    // Bounded the same way: the oldest scopes are the threads the reader has stopped opening.
    rememberPanelTool: (key, tool) => {
      const tools = get().panelTools[key] ?? [];
      if (tools.includes(tool)) return;
      const kept = Object.entries(get().panelTools)
        .filter(([k]) => k !== key)
        .slice(-99);
      commit({ panelTools: Object.fromEntries([...kept, [key, [...tools, tool]]]) });
    },
    setPanelExpanded: (panelExpanded) => set({ panelExpanded }),
  };
});
