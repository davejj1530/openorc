import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useSyncExternalStore } from "react";

/** A thread's side panel screens, each by the name of the route it also has in the stack. */
export const PANEL_NAMES = ["changes", "cloud-changes", "commit-changes", "diff", "cloud-diff", "files", "file", "preview", "subthreads"] as const;
export type PanelName = (typeof PANEL_NAMES)[number];

/** One screen of a thread's panel: which, and what it shows. Its params always name the thread. */
export interface PanelRoute {
  name: PanelName;
  params: { threadId: string } & Record<string, string>;
}

export const isPanelName = (name: string): name is PanelName => (PANEL_NAMES as readonly string[]).includes(name);

interface PaneState {
  /** The window has room for the panel beside the thread. Without it a panel's screens go over the thread. */
  room: boolean;
  /** The thread in front, which the panel beside it belongs to. */
  front: string | undefined;
  /** The pane's screens, the last one in front; none while it is closed. */
  routes: readonly PanelRoute[];
}

let state: PaneState = { room: false, front: undefined, routes: [] };
const listeners = new Set<() => void>();

function set(next: PaneState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

const pushOver = (route: PanelRoute) => router.push({ pathname: `/${route.name}`, params: route.params });

/**
 * The side panel beside a thread, where the window has room for it: an iPad on its side. It holds one thread's panel
 * screens, as the stack holds them over the thread everywhere else.
 */
export const pane = {
  /** Whether there is room. Losing it moves the open panel over the thread, so a turned iPad keeps it. */
  setRoom(room: boolean): void {
    if (room === state.room) return;
    const open = state.routes;
    set({ ...state, room, routes: [] });
    if (!room) open.forEach(pushOver);
  },
  /** A thread came to the front: a panel beside another thread closes. */
  cover(threadId: string): void {
    if (state.front === threadId) return;
    set({ ...state, front: threadId, routes: [] });
  },
  /** A thread left: its panel goes with it. */
  leave(threadId: string): void {
    if (state.front === threadId) set({ ...state, front: undefined, routes: [] });
  },
  /** Opens a thread's panel screen: beside the thread in front in place of what was there, and over it otherwise. */
  open(route: PanelRoute): void {
    if (state.room && state.front === route.params.threadId) set({ ...state, routes: [route] });
    else pushOver(route);
  },
  /** Within the pane: a screen over the one in front. */
  push(route: PanelRoute): void {
    set({ ...state, routes: [...state.routes, route] });
  },
  /** Within the pane: back to the screen under the one in front, or closed from the first. */
  back(): void {
    set({ ...state, routes: state.routes.slice(0, -1) });
  },
  /** Within the pane: the screen in front shows something else of its kind, as a diff steps to the next file. */
  setParams(params: Record<string, string>): void {
    const top = state.routes.at(-1);
    if (top) set({ ...state, routes: [...state.routes.slice(0, -1), { ...top, params: { ...top.params, ...params } }] });
  },
  close(): void {
    if (state.routes.length) set({ ...state, routes: [] });
  },
};

/** The pane's screens while it stands beside the thread; none while it is closed or there is no room. */
export function usePaneRoutes(): readonly PanelRoute[] {
  return useSyncExternalStore(subscribe, () => state.routes);
}

/** For a thread's screen: while it is in front the pane beside it is its own, and its panel goes when it leaves. */
export function useFrontOfPane(threadId: string): void {
  useFocusEffect(useCallback(() => pane.cover(threadId), [threadId]));
  useEffect(() => () => pane.leave(threadId), [threadId]);
}
