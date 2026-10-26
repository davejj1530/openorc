import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ChangeSelection, FileSelection, PanelTab } from "./layout";

export type PanelPage =
  | { kind: "newtab" }
  | { kind: "browser"; url: string; title: string }
  | { kind: "file"; selection: FileSelection | null }
  | { kind: "changes"; selection: ChangeSelection | null }
  | DevicePage
  | { kind: "tool"; tool: Exclude<PanelTab, "newtab" | "browser" | "file" | "changes" | "device">; shell?: TerminalShell };

/** A simulator or emulator's screen. With no device it is the picker; `name` labels the tab before the list loads. */
export type DevicePage = { kind: "device"; deviceId: string | null; name: string };

/** A Terminal tab's own shell. The conversation's first Terminal has none and keeps the conversation's shell. */
export type TerminalShell = { id: string; number: number };

export type WorkTab = { id: string; entries: [PanelPage, ...PanelPage[]]; index: number };
export type PanelSession = { tabs: [WorkTab, ...WorkTab[]]; activeId: string };

export const currentPage = (tab: WorkTab): PanelPage => tab.entries[tab.index] ?? tab.entries[0];
export const pageType = (page: PanelPage): PanelTab => (page.kind === "tool" ? page.tool : page.kind);
export const activeTab = (session: PanelSession): WorkTab => session.tabs.find((tab) => tab.id === session.activeId) ?? session.tabs[0];

const newTab = (id: string = crypto.randomUUID()): WorkTab => ({ id, entries: [{ kind: "newtab" }], index: 0 });
export const newPanelSession = (scope: string): PanelSession => ({ tabs: [newTab(scope)], activeId: scope });

function navigateTab(tab: WorkTab, page: PanelPage): WorkTab {
  const entries: [PanelPage, ...PanelPage[]] = [tab.entries[0], ...tab.entries.slice(1, tab.index + 1), page];
  return { ...tab, entries, index: entries.length - 1 };
}

function updateTab(session: PanelSession, id: string, update: (tab: WorkTab) => WorkTab): PanelSession {
  const [first, ...rest] = session.tabs;
  const change = (tab: WorkTab) => (tab.id === id ? update(tab) : tab);
  return { ...session, tabs: [change(first), ...rest.map(change)] };
}

function replacePage(tab: WorkTab, page: PanelPage): WorkTab {
  const replace = (entry: PanelPage, index: number) => (index === tab.index ? page : entry);
  return { ...tab, entries: [replace(tab.entries[0], 0), ...tab.entries.slice(1).map((entry, index) => replace(entry, index + 1))] };
}

/** Moves one tab to the front of the track, keeping the others in order. */
function toFront(session: PanelSession, id: string): PanelSession {
  const tab = session.tabs.find((entry) => entry.id === id);
  return tab ? { ...session, tabs: [tab, ...session.tabs.filter((entry) => entry.id !== id)] } : session;
}

function samePage(left: PanelPage, right: PanelPage): boolean {
  if (left.kind === "file" && right.kind === "file") return left.selection?.path === right.selection?.path;
  if (left.kind === "device" && right.kind === "device") return left.deviceId === right.deviceId;
  if (left.kind === "tool" && right.kind === "tool" && left.tool === "terminal") return right.tool === "terminal" && left.shell?.id === right.shell?.id;
  return pageType(left) === pageType(right);
}

/** The session without one tab: the tab before it takes over when it was active, and closing the last leaves a new tab. */
function withoutTab(session: PanelSession, id: string, scope: string): PanelSession {
  const index = session.tabs.findIndex((tab) => tab.id === id);
  const [first, ...rest] = session.tabs.filter((tab) => tab.id !== id);
  if (!first) return newPanelSession(scope);
  const tabs: PanelSession["tabs"] = [first, ...rest];
  return { tabs, activeId: session.activeId === id ? (tabs[Math.max(0, index - 1)] ?? first).id : session.activeId };
}

const showsDevice = (tab: WorkTab, deviceId: string) => {
  const page = currentPage(tab);
  return page.kind === "device" && page.deviceId === deviceId;
};

const terminalShells = (tab: WorkTab) => tab.entries.flatMap((page) => (page.kind === "tool" && page.tool === "terminal" ? [page.shell ?? null] : []));

/**
 * A Terminal opened while another tab already holds the conversation's shell gets a shell of its own, numbered after
 * the others, so each Terminal tab is its own shell.
 */
function withOwnShell(session: PanelSession, tabId: string, page: PanelPage): PanelPage {
  if (page.kind !== "tool" || page.tool !== "terminal" || page.shell) return page;
  const others = session.tabs.filter((tab) => tab.id !== tabId).flatMap(terminalShells);
  if (!others.includes(null)) return page;
  const number = Math.max(1, ...others.map((shell) => shell?.number ?? 1)) + 1;
  return { ...page, shell: { id: crypto.randomUUID(), number } };
}

interface PanelSessions {
  sessions: Record<string, PanelSession>;
  add: (scope: string) => void;
  select: (scope: string, id: string) => void;
  close: (scope: string, id: string) => void;
  navigate: (scope: string, page: PanelPage) => void;
  open: (scope: string, page: PanelPage, id?: string) => void;
  move: (scope: string, delta: number) => void;
  reportBrowser: (scope: string, id: string, url: string, title: string) => void;
  /** A device chosen in a tab's picker: that tab shows it, unless another tab already does. */
  pickDevice: (scope: string, tabId: string, page: DevicePage) => void;
  /** Every tab showing this device leaves the conversation's panel. */
  dropDevice: (scope: string, deviceId: string) => void;
}

/** Tabs belong to their conversation. Hiding the panel or visiting another thread preserves them. */
export const usePanelSessions = create<PanelSessions>()(
  persist(
    (set, get) => {
      const change = (scope: string, update: (session: PanelSession) => PanelSession) => {
        const sessions = get().sessions;
        const next = update(sessions[scope] ?? newPanelSession(scope));
        const kept = Object.entries(sessions)
          .filter(([key]) => key !== scope)
          .slice(-99);
        set({ sessions: Object.fromEntries([...kept, [scope, next]]) });
      };
      return {
        sessions: {},
        add: (scope) =>
          change(scope, (session) => {
            const tab = newTab(`${scope}:tab:${crypto.randomUUID()}`);
            return { tabs: [...session.tabs, tab], activeId: tab.id };
          }),
        select: (scope, id) => change(scope, (session) => ({ ...session, activeId: id })),
        close: (scope, id) => change(scope, (session) => withoutTab(session, id, scope)),
        navigate: (scope, page) => change(scope, (session) => updateTab(session, session.activeId, (tab) => navigateTab(tab, withOwnShell(session, tab.id, page)))),
        open: (scope, page, id) =>
          change(scope, (session) => {
            const existing = id ? session.tabs.find((tab) => tab.id === id) : session.tabs.find((tab) => samePage(currentPage(tab), page));
            const blank = currentPage(activeTab(session)).kind === "newtab" ? activeTab(session) : null;
            const target = existing ?? (id ? null : blank);
            if (target) {
              const next = { ...updateTab(session, target.id, (tab) => (samePage(currentPage(tab), page) ? replacePage(tab, page) : navigateTab(tab, page))), activeId: target.id };
              return target === blank && page.kind === "changes" ? toFront(next, target.id) : next;
            }
            const tab = navigateTab(newTab(id ?? `${scope}:tab:${crypto.randomUUID()}`), page);
            // Changes is the panel's first tab: it opens at the front of the track, and closes like any other.
            return { tabs: page.kind === "changes" ? [tab, ...session.tabs] : [...session.tabs, tab], activeId: tab.id };
          }),
        move: (scope, delta) => change(scope, (session) => updateTab(session, session.activeId, (tab) => ({ ...tab, index: Math.max(0, Math.min(tab.entries.length - 1, tab.index + delta)) }))),
        reportBrowser: (scope, id, url, title) =>
          change(scope, (session) =>
            updateTab(session, id, (tab) => {
              if (currentPage(tab).kind !== "browser") return tab;
              return replacePage(tab, { kind: "browser", url, title });
            }),
          ),
        pickDevice: (scope, tabId, page) =>
          change(scope, (session) => {
            const existing = session.tabs.find((tab) => tab.id !== tabId && samePage(currentPage(tab), page));
            if (existing) return { ...session, activeId: existing.id };
            return { ...updateTab(session, tabId, (tab) => navigateTab(tab, page)), activeId: tabId };
          }),
        dropDevice: (scope, deviceId) => {
          const showing = get().sessions[scope]?.tabs.filter((tab) => showsDevice(tab, deviceId)) ?? [];
          if (showing.length > 0) change(scope, (session) => showing.reduce((next, tab) => withoutTab(next, tab.id, scope), session));
        },
      };
    },
    { name: "openorc.panel-sessions", version: 1, partialize: (state) => ({ sessions: state.sessions }) },
  ),
);
