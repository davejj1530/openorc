import { relative, resolve, sep } from "node:path";
import ts from "typescript";
import { editorLanguage, FolderPath, type EditorFix, type EditorRequest, type EditorResult } from "@openorc/protocol";
import { TypeScriptProjects, inside, type TypeScriptProject } from "./typescript-project.js";
import { completionType, diagnostics, display, location, symbols } from "./typescript-results.js";

export type IntelligenceRequest = EditorRequest & { root: string };

function hover(project: TypeScriptProject, file: string, position: number): EditorResult {
  const info = project.service.getQuickInfoAtPosition(file, position);
  return {
    kind: "hover",
    info: info ? { from: info.textSpan.start, to: info.textSpan.start + info.textSpan.length, display: display(info.displayParts), documentation: display(info.documentation) } : null,
  };
}

function completion(project: TypeScriptProject, file: string, position: number): EditorResult {
  const text = project.read(file) ?? "";
  const word = /[\p{ID_Continue}$]*$/u.exec(text.slice(0, position))?.[0] ?? "";
  const result = project.service.getCompletionsAtPosition(file, position, {
    includeCompletionsForModuleExports: false,
    includeCompletionsWithInsertText: true,
    includeCompletionsWithSnippetText: false,
  });
  const entries = (result?.entries ?? [])
    .filter((entry) => !word || entry.name.toLowerCase().includes(word.toLowerCase()))
    .sort((a, b) => a.sortText.localeCompare(b.sortText) || a.name.localeCompare(b.name));
  const from = result?.optionalReplacementSpan?.start ?? position - word.length;
  const to = result?.optionalReplacementSpan ? from + result.optionalReplacementSpan.length : position;
  return {
    kind: "completion",
    from,
    to,
    options: entries.slice(0, 300).map((entry) => ({
      label: entry.name,
      type: completionType(entry.kind),
      insertText: entry.insertText ?? entry.name,
      detail: entry.kind,
      replace: entry.replacementSpan ? { from: entry.replacementSpan.start, to: entry.replacementSpan.start + entry.replacementSpan.length } : { from, to },
    })),
  };
}

function signature(project: TypeScriptProject, file: string, position: number): EditorResult {
  const help = project.service.getSignatureHelpItems(file, position, undefined);
  const item = help?.items[help.selectedItemIndex];
  if (!help || !item) return { kind: "signature", info: null };
  const parameter = item.parameters[Math.min(help.argumentIndex, item.parameters.length - 1)];
  const label = display(item.prefixDisplayParts) + item.parameters.map((part) => display(part.displayParts)).join(display(item.separatorDisplayParts)) + display(item.suffixDisplayParts);
  return {
    kind: "signature",
    info: { label: label.slice(0, 4_000), parameter: parameter ? display(parameter.displayParts) : "", documentation: display(parameter?.documentation) || display(item.documentation) },
  };
}

function navigate(project: TypeScriptProject, file: string, position: number, kind: "definition" | "references"): EditorResult {
  const spans = kind === "definition" ? (project.service.getDefinitionAtPosition(file, position) ?? []) : (project.service.getReferencesAtPosition(file, position) ?? []);
  const program = project.service.getProgram();
  const targets = spans.map((span) => location(project.root, program?.getSourceFile(span.fileName), span.textSpan)).filter((target) => target !== null);
  const unique = [...new Map(targets.map((target) => [`${target.path}:${target.from}:${target.to}`, target])).values()];
  return { kind, locations: unique.slice(0, 500), truncated: unique.length > 500 };
}

function fixChanges(project: TypeScriptProject, changes: ts.FileTextChanges[]): EditorFix["changes"] | null {
  const result: EditorFix["changes"] = [];
  for (const change of changes) {
    if (!inside(project.root, change.fileName) || change.isNewFile) return null;
    const path = FolderPath.safeParse(relative(project.root, change.fileName).split(sep).join("/"));
    const before = project.read(change.fileName);
    if (!path.success || before === undefined) return null;
    let after = before;
    let end = before.length;
    for (const edit of [...change.textChanges].sort((a, b) => b.span.start - a.span.start)) {
      if (edit.span.start < 0 || edit.span.start + edit.span.length > end) return null;
      after = after.slice(0, edit.span.start) + edit.newText + after.slice(edit.span.start + edit.span.length);
      end = edit.span.start;
    }
    if (after.length > 2 * 1024 * 1024) return null;
    if (after !== before) result.push({ path: path.data, before, after });
  }
  return result;
}

function fixes(project: TypeScriptProject, file: string, query: Extract<EditorRequest["query"], { kind: "fixes" }>): EditorResult {
  const actions = project.service.getCodeFixesAtPosition(file, query.from, query.to, [query.code], { indentSize: 2, tabSize: 2, newLineCharacter: "\n", convertTabsToSpaces: true }, {});
  const result: EditorFix[] = [];
  for (const action of actions.slice(0, 12)) {
    if (action.commands?.length || action.changes.length > 8) continue;
    const changes = fixChanges(project, action.changes);
    if (changes?.length) result.push({ title: action.description, changes });
  }
  return { kind: "fixes", fixes: result };
}

/** TypeScript's own project-aware engine. It runs only in the editor worker, never on the core's event loop. */
export class TypeScriptIntelligence {
  private readonly projects = new TypeScriptProjects();

  query(input: IntelligenceRequest): EditorResult {
    if (!editorLanguage(input.path)) return { kind: "unavailable", reason: "Code intelligence supports TypeScript and JavaScript files." };
    const file = resolve(input.root, input.path);
    const project = this.projects.get(input.root, file, input.documents);
    const { service } = project;
    const query = input.query;
    switch (query.kind) {
      case "analysis": {
        const source = service.getProgram()?.getSourceFile(file);
        if (!source) return { kind: "unavailable", reason: "TypeScript could not load this file." };
        return {
          kind: "analysis",
          diagnostics: diagnostics([...service.getSyntacticDiagnostics(file), ...service.getSemanticDiagnostics(file)], source.text.length),
          symbols: symbols(input.root, source, service.getNavigationTree(file)),
        };
      }
      case "hover":
        return hover(project, file, query.position);
      case "completion":
        return completion(project, file, query.position);
      case "signature":
        return signature(project, file, query.position);
      case "definition":
      case "references":
        return navigate(project, file, query.position, query.kind);
      case "fixes":
        return fixes(project, file, query);
      default: {
        const exhaustive: never = query;
        return exhaustive;
      }
    }
  }

  dispose(): void {
    this.projects.dispose();
  }
}
