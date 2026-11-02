import { z } from "zod";
import { FileScope, FolderPath } from "./files.js";

/** CodeMirror and TypeScript both count UTF-16 positions. Use LF in analysis, including for CRLF files. */
export const editorText = (text: string): string => text.replace(/\r\n/g, "\n");
export const editorLanguage = (path: string): boolean => /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(path);

const offset = z
  .number()
  .int()
  .nonnegative()
  .max(2 * 1024 * 1024);
const at = { position: offset };
export const EditorQuery = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("analysis") }).strict(),
  z.object({ kind: z.literal("hover"), ...at }).strict(),
  z.object({ kind: z.literal("completion"), ...at }).strict(),
  z.object({ kind: z.literal("signature"), ...at }).strict(),
  z.object({ kind: z.literal("definition"), ...at }).strict(),
  z.object({ kind: z.literal("references"), ...at }).strict(),
  z.object({ kind: z.literal("fixes"), from: offset, to: offset, code: z.number().int() }).strict(),
]);
export type EditorQuery = z.infer<typeof EditorQuery>;

export const EditorDocument = z.object({ path: FolderPath, text: z.string().max(2 * 1024 * 1024) }).strict();
export type EditorDocument = z.infer<typeof EditorDocument>;

export const editorRpcParams = {
  "editor.query": z
    .object({ scope: FileScope, expectedRoot: z.string().min(1).max(4096), path: FolderPath, documents: z.array(EditorDocument).min(1).max(32), query: EditorQuery })
    .strict()
    .superRefine((input, context) => {
      if (input.documents.reduce((size, document) => size + document.text.length, 0) > 4 * 1024 * 1024) context.addIssue({ code: "custom", message: "The editor's unsaved buffers exceed 4 MB." });
      if (new Set(input.documents.map((document) => document.path)).size !== input.documents.length) context.addIssue({ code: "custom", message: "Each editor buffer must have a distinct path." });
      const document = input.documents.find((document) => document.path === input.path);
      if (!document) context.addIssue({ code: "custom", message: "The current editor buffer is required." });
      const end = "position" in input.query ? input.query.position : 0;
      if (document && end > document.text.length) context.addIssue({ code: "custom", message: "The cursor is outside the editor buffer." });
      if (input.query.kind === "fixes" && (input.query.to < input.query.from || input.query.to > (document?.text.length ?? 0)))
        context.addIssue({ code: "custom", message: "The diagnostic is outside the editor buffer." });
    }),
};
export type EditorRequest = Pick<z.infer<(typeof editorRpcParams)["editor.query"]>, "path" | "documents" | "query">;

export interface EditorLocation {
  path: FolderPath;
  from: number;
  to: number;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  preview: string;
}

export interface EditorDiagnostic {
  from: number;
  to: number;
  severity: "error" | "warning" | "info";
  code: number;
  message: string;
}

export interface EditorSymbol {
  name: string;
  kind: string;
  depth: number;
  location: EditorLocation;
}

export interface EditorFix {
  title: string;
  /** Previewed changes become unsaved buffers; choosing a fix never writes to disk. */
  changes: { path: FolderPath; before: string; after: string }[];
}

export type EditorResult =
  | { kind: "analysis"; diagnostics: EditorDiagnostic[]; symbols: EditorSymbol[] }
  | { kind: "hover"; info: { from: number; to: number; display: string; documentation: string } | null }
  | { kind: "completion"; from: number; to: number; options: { label: string; type: string; insertText: string; detail: string; replace: { from: number; to: number } }[] }
  | { kind: "signature"; info: { label: string; parameter: string; documentation: string } | null }
  | { kind: "definition" | "references"; locations: EditorLocation[]; truncated: boolean }
  | { kind: "fixes"; fixes: EditorFix[] }
  | { kind: "unavailable"; reason: string };

export interface EditorRpcResults {
  "editor.query": EditorResult;
}
