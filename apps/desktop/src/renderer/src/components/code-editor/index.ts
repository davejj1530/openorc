import { lazy } from "react";

/**
 * The app's one code editor. CodeMirror stays behind this folder (ESLint refuses its imports anywhere else), and its
 * chunk loads the first time an editor renders, so a window that never opens a file never pays for it.
 */
export const CodeEditor = lazy(() => import("./CodeEditor").then((m) => ({ default: m.CodeEditor })));
/** Highlighted lines of a file outside the editor, in the editor's colors. Like the editor, it loads on first use. */
export const CodeExcerpt = lazy(() => import("./CodeExcerpt").then((m) => ({ default: m.CodeExcerpt })));
export { closeEditorSession } from "./sessions";
export type { CodeEditorProps, CodeEditorActions, EditorIntelligence, EditorPoint, LineRange } from "./types";
