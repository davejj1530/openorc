import { relative, sep } from "node:path";
import ts from "typescript";
import { FolderPath, type EditorDiagnostic, type EditorLocation, type EditorSymbol } from "@openorc/protocol";
import { inside } from "./typescript-project.js";

export const display = (parts: ts.SymbolDisplayPart[] | undefined): string => ts.displayPartsToString(parts).slice(0, 8_000);

/** Language-server positions use the normalized source, so CRLF and non-BMP characters land at the right caret. */
export function location(root: string, source: ts.SourceFile | undefined, span: ts.TextSpan): EditorLocation | null {
  if (!source || !inside(root, source.fileName)) return null;
  const path = FolderPath.safeParse(relative(root, source.fileName).split(sep).join("/"));
  if (!path.success) return null;
  const from = Math.min(span.start, source.text.length);
  const to = Math.min(span.start + span.length, source.text.length);
  const start = source.getLineAndCharacterOfPosition(from);
  const end = source.getLineAndCharacterOfPosition(to);
  const lines = source.getLineStarts();
  const preview = source.text
    .slice(lines[start.line], lines[start.line + 1] ?? source.text.length)
    .trim()
    .slice(0, 240);
  return { path: path.data, from, to, line: start.line + 1, column: start.character + 1, endLine: end.line + 1, endColumn: end.character + 1, preview };
}

export function diagnostics(items: readonly ts.Diagnostic[], length: number): EditorDiagnostic[] {
  return items.slice(0, 100).map((item) => ({
    from: Math.min(item.start ?? 0, length),
    to: Math.min((item.start ?? 0) + Math.max(item.length ?? 0, 1), length),
    code: item.code,
    severity: item.category === ts.DiagnosticCategory.Error ? "error" : "warning",
    message: ts.flattenDiagnosticMessageText(item.messageText, "\n").slice(0, 4_000),
  }));
}

export function symbols(root: string, source: ts.SourceFile, tree: ts.NavigationTree): EditorSymbol[] {
  const result: EditorSymbol[] = [];
  const visit = (nodes: ts.NavigationTree[], depth: number) => {
    for (const node of nodes) {
      if (result.length >= 500) return;
      const span = node.nameSpan ?? node.spans[0];
      const target = span ? location(root, source, span) : null;
      if (target) result.push({ name: node.text, kind: node.kind, depth, location: target });
      if (node.childItems) visit(node.childItems, depth + 1);
    }
  };
  visit(tree.childItems ?? [], 0);
  return result;
}

export function completionType(kind: ts.ScriptElementKind): string {
  switch (kind) {
    case ts.ScriptElementKind.functionElement:
    case ts.ScriptElementKind.memberFunctionElement:
      return "function";
    case ts.ScriptElementKind.classElement:
      return "class";
    case ts.ScriptElementKind.interfaceElement:
    case ts.ScriptElementKind.typeElement:
      return "type";
    case ts.ScriptElementKind.memberVariableElement:
    case ts.ScriptElementKind.memberGetAccessorElement:
    case ts.ScriptElementKind.memberSetAccessorElement:
      return "property";
    case ts.ScriptElementKind.keyword:
      return "keyword";
    default:
      return "variable";
  }
}
