import type { EditorDiagnostic, EditorFix, EditorLocation, EditorResult } from "@openorc/protocol";
import { create } from "zustand";
import { X } from "../components/icons";
import { IconButton } from "../components/ui";

export type CodeInsight =
  { kind: "locations"; title: "Definitions" | "References"; locations: EditorLocation[]; truncated: boolean } | { kind: "outline" } | { kind: "problems" } | { kind: "fixes"; fixes: EditorFix[] };

const useInsights = create<{ entries: Map<string, { path: string; insight: CodeInsight }> }>(() => ({ entries: new Map() }));
type InsightChange = CodeInsight | null | ((previous: CodeInsight | null) => CodeInsight | null);

/** References stay open while following file links; quick fixes belong to the file that requested them. */
export function useCodeInsight(key: string, path: string): [CodeInsight | null, (change: InsightChange) => void] {
  const entry = useInsights((state) => state.entries.get(key));
  const insight = entry && (entry.insight.kind !== "fixes" || entry.path === path) ? entry.insight : null;
  const change = (update: InsightChange) =>
    useInsights.setState((state) => {
      const current = state.entries.get(key);
      const previous = current && (current.insight.kind !== "fixes" || current.path === path) ? current.insight : null;
      const next = typeof update === "function" ? update(previous) : update;
      const entries = new Map(state.entries);
      if (next) entries.set(key, { path, insight: next });
      else entries.delete(key);
      return { entries: new Map([...entries].slice(-20)) };
    });
  return [insight, change];
}

interface Props {
  insight: CodeInsight;
  analysis: Extract<EditorResult, { kind: "analysis" }> | null;
  applying: boolean;
  onClose: () => void;
  onNavigate: (location: EditorLocation) => void;
  onDiagnostic: (diagnostic: EditorDiagnostic) => void;
  onFix: (fix: EditorFix) => void;
}

function titleOf(insight: CodeInsight): string {
  if (insight.kind === "locations") return insight.title;
  if (insight.kind === "outline") return "Outline";
  return insight.kind === "problems" ? "Problems" : "Quick fixes";
}

function countOf(insight: CodeInsight, analysis: Props["analysis"]): number {
  if (insight.kind === "locations") return insight.locations.length;
  if (insight.kind === "fixes") return insight.fixes.length;
  if (insight.kind === "outline") return analysis?.symbols.length ?? 0;
  return analysis?.diagnostics.length ?? 0;
}

function emptyLabel(insight: CodeInsight, title: string): string {
  if (insight.kind === "locations") return `No ${title.toLowerCase()} found in this workspace.`;
  if (insight.kind === "fixes") return "No quick fixes available here.";
  return `No ${title.toLowerCase()} to show.`;
}

/** One quiet result drawer below the code. It keeps the file and the user's current position in view. */
export function CodeInsights({ insight, analysis, applying, onClose, onNavigate, onDiagnostic, onFix }: Props) {
  const title = titleOf(insight);
  const count = countOf(insight, analysis);
  return (
    <section aria-label={title} className="file-insights" data-plane>
      <header>
        <span>
          {title} <span className="text-ink-4">{count}</span>
        </span>
        <IconButton size="xs" aria-label={`Close ${title.toLowerCase()}`} onClick={onClose}>
          <X size={14} />
        </IconButton>
      </header>
      <div className="file-insights-list">
        {insight.kind === "locations"
          ? insight.locations.map((location) => (
              <button key={`${location.path}:${location.from}`} className="file-insights-row" onClick={() => onNavigate(location)}>
                <span className="file-insights-name">
                  {location.path}
                  <span className="text-ink-4">
                    :{location.line}:{location.column}
                  </span>
                </span>
                <code>{location.preview}</code>
              </button>
            ))
          : null}
        {insight.kind === "outline"
          ? analysis?.symbols.map((symbol) => (
              <button
                key={`${symbol.location.from}:${symbol.name}`}
                className="file-insights-row"
                onClick={() => onNavigate(symbol.location)}
                style={{ paddingLeft: 10 + Math.min(symbol.depth, 5) * 12 }}
              >
                <span className="file-insights-name">{symbol.name}</span>
                <span className="text-ink-4">{symbol.kind}</span>
              </button>
            ))
          : null}
        {insight.kind === "problems"
          ? analysis?.diagnostics.map((diagnostic) => (
              <button key={`${diagnostic.from}:${diagnostic.code}`} className="file-insights-row" onClick={() => onDiagnostic(diagnostic)}>
                <span className={diagnostic.severity === "error" ? "text-bad" : "text-warn"}>{diagnostic.severity === "error" ? "Error" : "Warning"}</span>
                <span className="file-insights-name">{diagnostic.message}</span>
                <span className="text-ink-4">TS{diagnostic.code}</span>
              </button>
            ))
          : null}
        {insight.kind === "fixes"
          ? insight.fixes.map((fix) => (
              <button key={fix.title} className="file-insights-row" disabled={applying} onClick={() => onFix(fix)}>
                <span className="file-insights-name">{fix.title}</span>
              </button>
            ))
          : null}
        {!analysis && (insight.kind === "outline" || insight.kind === "problems") ? <p className="file-insights-empty">Checking the file…</p> : null}
        {!count && (analysis || insight.kind === "locations" || insight.kind === "fixes") ? <p className="file-insights-empty">{emptyLabel(insight, title)}</p> : null}
        {insight.kind === "locations" && insight.truncated ? <p className="file-insights-empty">Showing the first {count} results.</p> : null}
      </div>
    </section>
  );
}
