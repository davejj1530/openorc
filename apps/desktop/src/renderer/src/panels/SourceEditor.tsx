import { Suspense, useCallback, useMemo, useRef, useState } from "react";
import { editorLanguage, editorText, type FolderPath, type EditorDiagnostic, type EditorFix, type EditorLocation, type EditorResult } from "@openorc/protocol";
import { CodeEditor, type CodeEditorActions, type EditorIntelligence, type EditorPoint, type LineRange } from "../components/code-editor";
import { applyEditorFix, queryEditor } from "../lib/editor-intelligence";
import { editorCaret, editorNavigationKey, jumpInEditor, moveInEditor } from "../lib/editor-navigation";
import { flushDrafts, useDrafts } from "../lib/file-drafts";
import { useWordWrap } from "../lib/word-wrap";
import type { FileSelection } from "../lib/layout";
import type { FileBuffer } from "../lib/use-file-buffer";
import { CodeInsights, useCodeInsight } from "./CodeInsights";
import { EditorContextMenu } from "./EditorContextMenu";
import "./file-intelligence.css";

const reveals = new WeakMap<FileSelection, LineRange>();
function revealOf(selection: FileSelection): LineRange | null {
  if (!selection.line) return null;
  if (!reveals.has(selection)) reveals.set(selection, { start: selection.line, end: selection.endLine ?? selection.line, column: selection.column, endColumn: selection.endColumn });
  return reveals.get(selection) ?? null;
}

interface Props {
  buffer: FileBuffer;
  sessionKey: string;
  selection: FileSelection;
  text: string;
  path: FolderPath;
  root: string;
  onReady: (actions: CodeEditorActions | null) => void;
}

function diagnosticLocation(path: EditorLocation["path"], text: string, diagnostic: EditorDiagnostic): EditorLocation {
  const before = editorText(text).slice(0, diagnostic.from).split("\n");
  const through = editorText(text).slice(0, diagnostic.to).split("\n");
  const column = (before.at(-1)?.length ?? 0) + 1;
  return {
    path,
    from: diagnostic.from,
    to: diagnostic.to,
    line: before.length,
    column,
    endLine: through.length,
    endColumn: (through.at(-1)?.length ?? 0) + 1,
    preview: diagnostic.message,
  };
}

function useEditorFeatures({ selection, root, path, text, buffer }: Props) {
  const actions = useRef<CodeEditorActions | null>(null);
  const [analysis, setAnalysis] = useState<Extract<EditorResult, { kind: "analysis" }> | null>(null);
  const key = editorNavigationKey(selection.scope, root);
  const [insight, setInsight] = useCodeInsight(key, path);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const drafts = useDrafts((state) => state.loaded);
  const version = "file" in buffer.view && "version" in buffer.view.file ? buffer.view.file.version : null;
  const refreshing = buffer.read.refreshing;
  const analysisKey = useMemo(() => ({ drafts, version, refreshing }), [drafts, version, refreshing]);
  const current = () => editorCaret({ ...selection, path }, actions.current?.point());
  const navigate = (location: EditorLocation, origin: EditorPoint) =>
    jumpInEditor(key, editorCaret({ ...selection, path }, origin), {
      scope: selection.scope,
      path: location.path,
      line: location.line,
      column: location.column,
      endLine: location.endLine,
      endColumn: location.endColumn,
    });
  const intelligence: EditorIntelligence | undefined =
    editorLanguage(path) && !buffer.outside
      ? {
          query: (query, currentText) => queryEditor({ scope: selection.scope, root, path, text: currentText, query }),
          navigate,
          locations: (title, locations, truncated) => setInsight({ kind: "locations", title, locations, truncated }),
          analysis: setAnalysis,
          fixes: (fixes) => setInsight({ kind: "fixes", fixes }),
          outline: () => setInsight((current) => (current?.kind === "outline" ? null : { kind: "outline" })),
          problems: () => setInsight((current) => (current?.kind === "problems" ? null : { kind: "problems" })),
          error: setError,
          back: () => moveInEditor(key, "back", current()),
          forward: () => moveInEditor(key, "forward", current()),
        }
      : undefined;
  const close = () => {
    setInsight(null);
    actions.current?.focus();
  };
  const apply = async (fix: EditorFix) => {
    if (applying || buffer.readOnly) return;
    setApplying(true);
    try {
      await applyEditorFix(selection.scope, root, fix);
      setError(null);
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The fix could not be applied.");
    } finally {
      setApplying(false);
    }
  };
  return {
    actions,
    analysis,
    insight,
    error,
    applying,
    analysisKey,
    intelligence,
    close,
    apply,
    navigate: (location: EditorLocation) => navigate(location, actions.current?.point() ?? { line: 1, column: 1 }),
    diagnostic: (diagnostic: EditorDiagnostic) => {
      navigate(diagnosticLocation(path, text, diagnostic), actions.current?.point() ?? { line: 1, column: 1 });
    },
  };
}

export function SourceEditor(props: Props) {
  const { buffer, sessionKey, selection, text, path, onReady } = props;
  const features = useEditorFeatures(props);
  const wordWrap = useWordWrap();
  const lines = Math.max(1, text.split("\n").length - (text.endsWith("\n") ? 1 : 0));
  const ready = useCallback(
    (actions: CodeEditorActions | null) => {
      features.actions.current = actions;
      onReady(actions);
    },
    [features.actions, onReady],
  );
  return (
    <div className="file-source">
      {selection.line && selection.line > lines ? (
        <p role="status" className="p-3 text-sm text-ink-3">
          Line {selection.line} is past the end of this file. Showing line {lines}.
        </p>
      ) : null}
      <EditorContextMenu actions={features.actions} supported={Boolean(features.intelligence)} readOnly={buffer.readOnly !== null} format={buffer.format}>
        <div className="h-full min-h-0" onBlur={() => void flushDrafts()}>
          <Suspense fallback={<p className="p-4 text-sm text-ink-3">Loading editor…</p>}>
            <CodeEditor
              sessionKey={sessionKey}
              path={path}
              text={text}
              readOnly={buffer.readOnly !== null}
              lineWrapping={wordWrap.wrap}
              onLineWrappingChange={wordWrap.setWrap}
              reveal={revealOf(selection)}
              focusRequest={buffer.focusRequest}
              onChange={buffer.edit}
              onSave={buffer.save}
              onFormat={buffer.format}
              onReady={ready}
              intelligence={features.intelligence}
              analysisKey={features.analysisKey}
            />
          </Suspense>
        </div>
      </EditorContextMenu>
      {features.error ? (
        <p role="status" className="file-intelligence-note">
          {features.error}
          <button className="ml-2 text-ink-2" onClick={() => features.actions.current?.refresh()}>
            Retry
          </button>
        </p>
      ) : null}
      {features.intelligence ? (
        <button className="file-problems-status" onClick={() => features.intelligence?.problems()} aria-label={`Problems, ${features.analysis?.diagnostics.length ?? 0}`}>
          {features.analysis ? `${features.analysis.diagnostics.length} ${features.analysis.diagnostics.length === 1 ? "problem" : "problems"}` : "TypeScript / JavaScript"}
        </button>
      ) : null}
      {features.insight ? (
        <CodeInsights
          insight={features.insight}
          analysis={features.analysis}
          applying={features.applying}
          onClose={features.close}
          onNavigate={features.navigate}
          onDiagnostic={features.diagnostic}
          onFix={(fix) => void features.apply(fix)}
        />
      ) : null}
    </div>
  );
}
