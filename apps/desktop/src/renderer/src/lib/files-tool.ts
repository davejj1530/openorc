import { useEffect, type RefObject } from "react";
import { create } from "zustand";
import type { FileScope, FindQuery } from "@openorc/protocol";
import { useLayout } from "./layout";
import { useRouter } from "./router";

/** Browse the tree, find file names (Cmd+P), or search their contents (Cmd+Shift+F). */
export type FilesMode = "tree" | "names" | "contents";

/** One conversation's Files tool for this session: its mode and what was typed in each. */
interface FilesTool {
  mode: FilesMode;
  names: string;
  /** `text` may be empty here; a find runs once there is something to find. */
  contents: FindQuery;
}

interface FilesToolState {
  /** The conversation whose panel is mounted. Panel is the only writer. */
  host: FileScope | null;
  /** Set by Cmd+P and Cmd+Shift+F. The Files tool that shows next takes it and selects its search box. */
  focus: object | null;
  /** Each conversation's tool, by `filesKey`. */
  tools: Record<string, FilesTool>;
}

const EMPTY: FilesTool = { mode: "tree", names: "", contents: { text: "", regex: false, caseSensitive: false } };

export const useFilesTool = create<FilesToolState>(() => ({ host: null, focus: null, tools: {} }));

export function filesKey(scope: FileScope): string {
  return scope.kind === "project" ? `project:${scope.id}:${scope.workingDirectory ?? ""}` : `${scope.kind}:${scope.id}`;
}

function updateTool(key: string, change: Partial<FilesTool>): void {
  useFilesTool.setState((state) => ({ tools: { ...state.tools, [key]: { ...(state.tools[key] ?? EMPTY), ...change } } }));
}

/** One conversation's Files tool, and a setter that merges a change into it. */
export function useFilesToolState(scope: FileScope): [FilesTool, (change: Partial<FilesTool>) => void] {
  const key = filesKey(scope);
  const tool = useFilesTool((state) => state.tools[key]) ?? EMPTY;
  return [tool, (change) => updateTool(key, change)];
}

/** Asks the Files tool that shows next to focus its search box. Showing it alone never takes focus from where the user is. */
export function requestFilesFocus(): void {
  useFilesTool.setState({ focus: {} });
}

/** A Files tool's search box takes a focus request, its text selected for typing over. */
export function useFilesFocus(input: RefObject<HTMLInputElement | null>, enabled = true): void {
  const focus = useFilesTool((state) => state.focus);
  useEffect(() => {
    if (!focus || !enabled) return;
    input.current?.focus();
    input.current?.select();
    useFilesTool.setState({ focus: null });
  }, [focus, input, enabled]);
}

/** Panel names the conversation its Files tool works in, for as long as it is mounted. */
export function useFilesHost(scope: FileScope): void {
  const { kind, id } = scope;
  const directory = scope.kind === "project" ? scope.workingDirectory : undefined;
  useEffect(() => {
    const host: FileScope = kind === "project" ? { kind, id, workingDirectory: directory } : { kind, id };
    useFilesTool.setState({ host });
    return () => {
      if (useFilesTool.getState().host === host) useFilesTool.setState({ host: null });
    };
  }, [kind, id, directory]);
}

/** The thread in the focused pane, while the window shows threads. */
export function focusedThread(): string | null {
  const { route } = useRouter.getState();
  return route.view === "thread" ? route.threadId : null;
}

/** What Cmd+P, Cmd+Shift+F and New file act on: the focused thread, whose panel they open, else the conversation whose panel is mounted. */
export function fileTarget(focusedThreadId: string | null): FileScope | null {
  return focusedThreadId ? { kind: "thread", id: focusedThreadId } : useFilesTool.getState().host;
}

/** Cmd+P and Cmd+Shift+F: the Files tool in `mode` on the target's panel, its search box focused. False when no conversation is on screen. */
export function openFilesTool(mode: FilesMode, focusedThreadId: string | null): boolean {
  const target = fileTarget(focusedThreadId);
  if (!target) return false;
  updateTool(filesKey(target), { mode });
  requestFilesFocus();
  useLayout.getState().openFiles(focusedThreadId ?? undefined);
  return true;
}
