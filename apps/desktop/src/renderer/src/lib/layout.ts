import { liveGroupedFold, liveHiddenWorkspaces, pruneThreadFolds, toggleSidebarFold, toggleThreadTree, toggleWorkspace, type PanelTool } from "@openorc/client";
import type { RpcParams } from "@openorc/protocol";
import { WORKSPACE_ID } from "@openorc/protocol";
import { create } from "zustand";
import type { FileReference } from "../../../shared/file-reference";
import { withFileScope } from "./file-scope";
import { navigationScope } from "./navigation-scope";

/** The shared panel tools, and the desktop's own Device panel. */
export type PanelTab = PanelTool | "device";
/** One turn's saved diff, opened from its change card. */
export type ChangeSelection = { kind: "thread" } & Omit<RpcParams<"threads.turnChanges">, "includePatch">;
export type FileSelection = FileReference & { scope: RpcParams<"files.read">["scope"]; column?: number; endColumn?: number };
export type WorkspaceChangesTarget = { kind: "thread" | "project"; id: string };
export type WorkspaceChangesRequest = WorkspaceChangesTarget & { comparison: "base" | "head"; commit: boolean; requestId: number };

/** Which side of the conversation the shared panel docks on. */
export type PanelSide = "left" | "right";

/** A screen the sidebar lists by name, above the threads. */
export type SidebarScreen = "tasks" | "pulls" | "scheduled";

/** All projects: the sidebar lists every project's threads. A project's id lists only its own. */
export const ALL_WORKSPACES = "all";

/** The project the sidebar's filter focuses, or null on All projects. */
export const focusedProject = (state: { workspace: string }): string | null => (state.workspace === ALL_WORKSPACES ? null : state.workspace);

interface LayoutState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  panelOpen: boolean;
  panelWidth: number;
  panelSide: PanelSide;
  panelTab: PanelTab;
  /** The tab asked for, and with Commits the one commit to open there. */
  panelRequest: { tab: PanelTab; commit?: string } | null;
  selectedChanges: ChangeSelection | null;
  openChanges: (selection: ChangeSelection) => void;
  clearChanges: () => void;
  workspaceChanges: WorkspaceChangesRequest | null;
  openWorkspaceChanges: (target: WorkspaceChangesTarget, action?: "review" | "commit", comparison?: "base" | "head") => void;
  consumeWorkspaceCommit: (requestId: number) => void;
  selectedFile: FileSelection | null;
  openFile: (file: FileSelection) => void;
  /** The Files tool rather than a file a link chose: on this thread's panel when given, else on the panel on screen. */
  openFiles: (threadId?: string) => void;
  /**
   * The app's scope, chosen at the head of a screen's title: one project, or every project under ALL_WORKSPACES.
   * Tasks, schedules, pull requests, memory and new work follow it; read it with focusedProject. The sidebar lists every
   * project's threads, each project in its own group.
   */
  workspace: string;
  /** The visible thread whose controls last opened the shared panel. */
  panelThreadId: string | null;
  toggleThreadPanel: (id: string) => void;
  openThreadPanel: (id: string, tab: PanelTab) => void;
  /** One of a thread's commits, in its Commits tab. */
  openCommit: (threadId: string, sha: string) => void;
  /** Only the pinned threads. Never persisted: a relaunch lists them all again. */
  pinnedOnly: boolean;
  /** Workspaces the person unticked in the sidebar's filter, kept on this device. What is hidden is stored, so a new one shows. */
  hiddenWorkspaces: string[];
  /** Sidebar sections the user folded: namespaced project/pinned keys, plus opt-in snoozed-open keys. */
  collapsed: string[];
  revealThreads: (ancestors: readonly string[]) => void;
  pruneThreadFolds: (missing: ReadonlySet<string>) => void;
  /**
   * Where each surface's preview was last pointed, keyed the way the panel
   * keys its panes. A dev server's port belongs to the project, not to us, so
   * the only honest default is the one the reader already chose here.
   */
  previewUrls: Record<string, string>;
  /** The panel fills the work row. Never persisted: a relaunch opens it at its saved width. */
  panelExpanded: boolean;
  toggleSidebar: () => void;
  setSidebarWidth: (px: number) => void;
  setPanel: (open: boolean, tab?: PanelTab) => void;
  setPanelWidth: (px: number) => void;
  togglePanelSide: () => void;
  setWorkspace: (id: string) => void;
  /** Work opened in another project brings a focused filter along to it; on All projects the filter stays. */
  followProject: (id: string) => void;
  setPinnedOnly: (pinnedOnly: boolean) => void;
  toggleWorkspace: (id: string) => void;
  /** Forgets hidden workspaces not in `known`, every workspace the list has. */
  pruneHiddenWorkspaces: (known: readonly string[]) => void;
  toggleCollapsed: (key: string) => void;
  toggleThreadChildren: (id: string, expanded: boolean) => void;
  rememberPreviewUrl: (key: string, url: string) => void;
  setPanelExpanded: (expanded: boolean) => void;
}

export const limits = {
  sidebar: { min: 224, max: 380, default: 247 },
  panel: { min: 340, max: 900, default: 640 },
};

const KEY = "openorc.layout";

type Saved = Partial<Pick<LayoutState, "sidebarOpen" | "panelOpen" | "panelWidth" | "panelSide" | "workspace" | "hiddenWorkspaces" | "collapsed" | "previewUrls">> & {
  /** The whole sidebar's width. The rail's layouts saved `sidebarWidth`, the thread list's width beside it, which no longer applies. */
  navigationWidth?: number;
};

function read(): Saved {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Saved;
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
        navigationWidth: s.sidebarWidth,
        panelOpen: s.panelOpen,
        panelWidth: s.panelWidth,
        panelSide: s.panelSide,
        workspace: navigationScope.active ? read().workspace : s.workspace,
        hiddenWorkspaces: navigationScope.active ? read().hiddenWorkspaces : s.hiddenWorkspaces,
        collapsed: s.collapsed,
        previewUrls: s.previewUrls,
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

/** The three-column frame: sidebar, main, and an optional panel on either side of main. Sizes and the panel's side persist across launches. */
function threadFoldActions(get: () => LayoutState, commit: (patch: Partial<LayoutState>) => void): Pick<LayoutState, "revealThreads" | "pruneThreadFolds"> {
  const save = (collapsed: string[]) => {
    if (collapsed.length !== get().collapsed.length) commit({ collapsed });
  };
  return {
    revealThreads: (ancestors) => {
      const closed = new Set(ancestors.map((id) => `thread-closed:${id}`));
      save(get().collapsed.filter((key) => !closed.has(key)));
    },
    pruneThreadFolds: (missing) => save(pruneThreadFolds(get().collapsed, missing)),
  };
}

export const useLayout = create<LayoutState>((set, get) => {
  const saved = read();
  const initial = {
    sidebarOpen: saved.sidebarOpen ?? true,
    sidebarWidth: clamp(saved.navigationWidth ?? limits.sidebar.default, limits.sidebar),
    panelOpen: saved.panelOpen ?? false,
    panelWidth: clamp(saved.panelWidth ?? limits.panel.default, limits.panel),
    panelSide: saved.panelSide === "left" ? ("left" as const) : ("right" as const),
    panelTab: "newtab" as PanelTab,
    panelRequest: null,
    selectedFile: null,
    selectedChanges: null,
    workspaceChanges: null,
    // Layouts saved before the project filter list every project, as the sidebar did then.
    workspace: typeof saved.workspace === "string" && saved.workspace ? saved.workspace : ALL_WORKSPACES,
    panelThreadId: null,
    pinnedOnly: false,
    hiddenWorkspaces: Array.isArray(saved.hiddenWorkspaces) ? saved.hiddenWorkspaces.filter((id) => typeof id === "string") : [],
    collapsed: (saved.collapsed ?? []).filter(liveGroupedFold),
    previewUrls: saved.previewUrls ?? {},
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
    setPanel: (open, tab) => commit({ panelOpen: open, ...(tab ? { panelTab: tab, panelRequest: { tab } } : {}), ...(open ? {} : { panelExpanded: false }) }),
    openChanges: (selectedChanges) => {
      let threadSelection: Partial<Pick<LayoutState, "panelThreadId">> = {};
      if (selectedChanges.kind === "thread") threadSelection = { panelThreadId: selectedChanges.id };
      commit({
        selectedChanges,
        panelOpen: true,
        panelTab: "changes",
        panelRequest: { tab: "changes" },
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
        panelRequest: { tab: "changes" },
        panelThreadId: target.kind === "thread" ? target.id : null,
      }),
    consumeWorkspaceCommit: (requestId) => {
      const request = get().workspaceChanges;
      if (request?.requestId === requestId) set({ workspaceChanges: { ...request, commit: false } });
    },
    openFile: (selectedFile) =>
      withFileScope(selectedFile.scope, () =>
        commit({ selectedFile, panelOpen: true, panelTab: "file", panelRequest: { tab: "file" }, ...(selectedFile.scope.kind === "thread" ? { panelThreadId: selectedFile.scope.id } : {}) }),
      ),
    openFiles: (threadId) => commit({ selectedFile: null, panelOpen: true, panelTab: "file", panelRequest: { tab: "file" }, ...(threadId ? { panelThreadId: threadId } : {}) }),
    setPanelWidth: (px) => commit({ panelWidth: clamp(px, limits.panel) }),
    togglePanelSide: () => commit({ panelSide: get().panelSide === "left" ? "right" : "left" }),
    setWorkspace: (workspace) => commit({ workspace }),
    // Workspace's threads have no project of their own in the filter, so they show under All projects.
    followProject: (id) => {
      if (get().workspace !== ALL_WORKSPACES) commit({ workspace: id === WORKSPACE_ID ? ALL_WORKSPACES : id });
    },
    openThreadPanel: (id, tab) => commit({ panelThreadId: id, panelOpen: true, panelTab: tab, panelRequest: { tab } }),
    openCommit: (threadId, sha) => commit({ panelThreadId: threadId, panelOpen: true, panelTab: "commits", panelRequest: { tab: "commits", commit: sha } }),
    toggleThreadPanel: (id) => {
      const open = get().panelThreadId !== id || !get().panelOpen;
      commit({ panelThreadId: id, panelOpen: open, ...(open ? {} : { panelExpanded: false }) });
    },
    setPinnedOnly: (pinnedOnly) => commit({ pinnedOnly }),
    toggleWorkspace: (id) => commit({ hiddenWorkspaces: toggleWorkspace(get().hiddenWorkspaces, id) }),
    pruneHiddenWorkspaces: (known) => {
      const live = liveHiddenWorkspaces(get().hiddenWorkspaces, known);
      if (live.length !== get().hiddenWorkspaces.length) commit({ hiddenWorkspaces: live });
    },
    toggleCollapsed: (key) => commit({ collapsed: toggleSidebarFold(get().collapsed, key) }),
    toggleThreadChildren: (id, expanded) => commit({ collapsed: toggleThreadTree(get().collapsed, id, expanded) }),
    ...threadFoldActions(get, commit),
    // Bounded because the key is a surface id and threads are unbounded; the
    // oldest entries are the ones whose thread the reader has stopped opening.
    rememberPreviewUrl: (key, url) => {
      const kept = Object.entries(get().previewUrls)
        .filter(([k]) => k !== key)
        .slice(-49);
      commit({ previewUrls: Object.fromEntries([...kept, [key, url]]) });
    },
    setPanelExpanded: (panelExpanded) => set({ panelExpanded }),
  };
});
