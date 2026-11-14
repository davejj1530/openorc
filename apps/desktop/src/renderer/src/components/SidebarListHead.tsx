import type { ReactNode } from "react";
import { ChevronRight } from "./icons";
import { OpenOrcMark } from "./OpenOrcMark";

/** OpenOrc's wordmark: the cube and the name, always in Immaculate Gothic. Short of room, the name gives way whole. */
export function Wordmark() {
  return (
    <div className="sidebar-wordmark" role="img" aria-label="OpenOrc">
      <OpenOrcMark size={16} className="shrink-0" />
      <span className="sidebar-wordmark-name">OpenOrc</span>
    </div>
  );
}

/**
 * The head of one of the sidebar's lists: its quiet name, then its tools at the row's end. A list that folds names
 * itself with a button, its chevron showing on hover and while folded; folded, it counts what inside waits on the
 * person, when anything does.
 */
export function SidebarListHead({
  label,
  fold,
  tools,
}: {
  label: string;
  fold?: { open: boolean; waiting: number; onToggle: () => void; folded?: { marks: ReactNode; words: string } | undefined };
  tools: ReactNode;
}) {
  return (
    <div className="sidebar-list-head" data-open={!fold || fold.open || undefined}>
      {fold ? (
        <button type="button" aria-expanded={fold.open} aria-label={foldedLabel(label, fold)} className="sidebar-list-fold no-drag" onClick={fold.onToggle}>
          <span>{label}</span>
          <ChevronRight size={12} className="sidebar-section-chevron" />
          {!fold.open && fold.waiting ? <span className="sidebar-count tabular">{fold.waiting}</span> : null}
          {!fold.open && fold.folded ? fold.folded.marks : null}
        </button>
      ) : (
        <h2 className="sidebar-list-name">{label}</h2>
      )}
      <div className="sidebar-list-tools">{tools}</div>
    </div>
  );
}

/** What a folded list says it holds, for a screen reader: its own words when it has them, else what waits. */
function foldedLabel(label: string, fold: { open: boolean; waiting: number; folded?: { words: string } | undefined }): string | undefined {
  if (fold.open) return undefined;
  if (fold.folded) return `${label}, ${fold.folded.words}`;
  return fold.waiting ? `${label}, ${fold.waiting} waiting` : undefined;
}
