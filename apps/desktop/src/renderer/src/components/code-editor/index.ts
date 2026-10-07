import { lazy } from "react";

/**
 * The app's one code editor. CodeMirror stays behind this folder (ESLint refuses its imports anywhere else), and its
 * chunk loads the first time an editor renders, so a window that never opens a file never pays for it.
 */
export const CodeEditor = lazy(() => import("./CodeEditor").then((m) => ({ default: m.CodeEditor })));
export { closeEditorSession } from "./sessions";
export type { CodeEditorProps, LineRange } from "./types";
