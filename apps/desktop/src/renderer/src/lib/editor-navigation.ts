import { create } from "zustand";
import type { FileScope } from "@openorc/protocol";
import { useLayout, type FileSelection } from "./layout";
import { filesKey } from "./files-tool";

interface History {
  back: FileSelection[];
  forward: FileSelection[];
}
interface Navigation {
  histories: Record<string, History>;
}
const EMPTY: History = { back: [], forward: [] };
export const useEditorNavigation = create<Navigation>(() => ({ histories: {} }));
export const editorNavigationKey = (scope: FileScope, root: string) => JSON.stringify([filesKey(scope), root]);

export function editorCaret(selection: FileSelection, point?: { line: number; column: number }): FileSelection {
  const line = point?.line ?? selection.line ?? 1;
  const column = point?.column ?? selection.column ?? 1;
  return { scope: selection.scope, path: selection.path, line, column, endLine: line, endColumn: column };
}

function keep(key: string, history: History): void {
  useEditorNavigation.setState((state) => ({
    histories: Object.fromEntries([
      ...Object.entries(state.histories)
        .filter(([entry]) => entry !== key)
        .slice(-19),
      [key, history],
    ]),
  }));
}

export function jumpInEditor(key: string, origin: FileSelection, target: FileSelection): void {
  const history = useEditorNavigation.getState().histories[key] ?? EMPTY;
  keep(key, { back: [...history.back, origin].slice(-80), forward: [] });
  useLayout.getState().openFile(target);
}

export function moveInEditor(key: string, direction: "back" | "forward", current: FileSelection): boolean {
  const history = useEditorNavigation.getState().histories[key] ?? EMPTY;
  const target = history[direction].at(-1);
  if (!target) return false;
  const other = direction === "back" ? "forward" : "back";
  keep(key, { ...history, [direction]: history[direction].slice(0, -1), [other]: [...history[other], current].slice(-80) });
  useLayout.getState().openFile(target);
  return true;
}
