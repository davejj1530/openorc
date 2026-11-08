import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { FileSelection } from "../lib/layout";
import { currentPage, type PanelPage, type PanelSession, type WorkTab } from "../lib/panel-tabs";
import { useUnsavedFile } from "../lib/use-file-buffer";
import { pageIcon, tabLabel } from "./panel-tools";
import { X } from "./icons";
import { cn } from "../lib/cn";
import { PANE_MS, prefersReducedMotion } from "../lib/motion";
import { useStripHandoff } from "../lib/strip-handoff";

function nextTab(session: PanelSession, index: number, key: string): WorkTab | undefined {
  if (key === "Home") return session.tabs[0];
  if (key === "End") return session.tabs.at(-1);
  if (key === "ArrowRight") return session.tabs[(index + 1) % session.tabs.length];
  if (key === "ArrowLeft") return session.tabs[(index - 1 + session.tabs.length) % session.tabs.length];
  return undefined;
}

interface TabProps {
  tab: WorkTab;
  page: PanelPage;
  active: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

/** One tab, drawn like the work column's: the tool's glyph, or a dot while a file has unsaved edits, then its name and close. */
function PanelTab({ tab, page, active, unsaved, onSelect, onClose, onKeyDown }: TabProps & { unsaved: boolean }) {
  const label = tabLabel(page);
  const Icon = pageIcon(page);
  return (
    <div role="presentation" data-tab={tab.id} className={cn("work-tab", active && "work-tab-current")}>
      <button
        role="tab"
        className="work-tab-face"
        id={`panel-tab-${tab.id}`}
        aria-controls="panel-tab-content"
        aria-label={unsaved ? `${label}, unsaved changes` : label}
        aria-selected={active}
        tabIndex={active ? 0 : -1}
        title={label}
        onClick={() => onSelect(tab.id)}
        onAuxClick={(event) => {
          if (event.button === 1) {
            event.preventDefault();
            onClose(tab.id);
          }
        }}
        onKeyDown={onKeyDown}
      >
        <span className="work-tab-icon" aria-hidden="true">
          {unsaved ? <span className="panel-tab-dot" /> : <Icon size={14} />}
        </span>
        <span className="work-tab-title">{label}</span>
      </button>
      <button className="work-tab-close" aria-label={`Close ${label}`} title={`Close ${label}`} onClick={() => onClose(tab.id)}>
        <X size={12} />
      </button>
    </div>
  );
}

function FileTab({ selection, ...props }: TabProps & { selection: FileSelection }) {
  return <PanelTab {...props} unsaved={useUnsavedFile(selection)} />;
}

/** A closed tab's stand-in, folding away from the width the tab had: its glyph and name, and nothing to press. */
function FoldingTab({ tab }: { tab: WorkTab }) {
  const page = currentPage(tab);
  const Icon = pageIcon(page);
  return (
    <div role="presentation" aria-hidden="true" data-tab={tab.id} data-leaving="" inert className="work-tab">
      <span className="work-tab-face">
        <span className="work-tab-icon">
          <Icon size={14} />
        </span>
        <span className="work-tab-title">{tabLabel(page)}</span>
      </span>
    </div>
  );
}

/**
 * Tabs just closed, where they stood, for as long as they take to fold away. Closing ends a tab's browser or shell at
 * once, so what folds is a stand-in.
 */
function useFoldingTabs(tabs: readonly WorkTab[]): { tab: WorkTab; index: number }[] {
  const [folding, setFolding] = useState<{ tab: WorkTab; index: number }[]>([]);
  const previous = useRef(tabs);
  useLayoutEffect(() => {
    const gone = previous.current.flatMap((tab, index) => (tabs.some((each) => each.id === tab.id) ? [] : [{ tab, index }]));
    previous.current = tabs;
    if (!gone.length) return;
    setFolding((now) => [...now, ...gone]);
    setTimeout(() => setFolding((now) => now.filter((entry) => !gone.includes(entry))), typeof window.matchMedia === "function" && prefersReducedMotion() ? 0 : PANE_MS);
  }, [tabs]);
  return folding;
}

/** The strip's tabs with the ones folding away put back where they stood. */
function withFolding<T>(tabs: readonly T[], folding: { tab: T; index: number }[]): { tab: T; leaving: boolean }[] {
  const rows = tabs.map((tab) => ({ tab, leaving: false }));
  for (const { tab, index } of [...folding].sort((a, b) => a.index - b.index)) rows.splice(Math.min(index, rows.length), 0, { tab, leaving: true });
  return rows;
}

/** The panel's tabs. The strip scrolls sideways when they outgrow it, keeping the open tab in view. */
export function PanelTabs({ session, onSelect, onClose }: { session: PanelSession; onSelect: (id: string) => void; onClose: (id: string) => void }) {
  const strip = useRef<HTMLDivElement>(null);
  // Tabs there when the strip first draws appear in place; later ones grow in.
  const known = useRef(new Set(session.tabs.map((tab) => tab.id)));
  const folding = useFoldingTabs(session.tabs);
  useStripHandoff(strip, (id) => !known.current.has(id));
  useEffect(() => {
    for (const tab of session.tabs) known.current.add(tab.id);
  });
  // Instant as the strip first draws, a glide after.
  const revealed = useRef(false);
  useEffect(() => {
    const behavior = revealed.current ? "smooth" : "instant";
    revealed.current = true;
    strip.current?.querySelector('[aria-selected="true"]')?.closest(".work-tab")?.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior });
  }, [session.activeId]);
  return (
    <div ref={strip} role="tablist" aria-label="Panel tabs" className="panel-tabs work-tabs no-drag">
      {withFolding(session.tabs, folding).map(({ tab, leaving }) => {
        if (leaving) return <FoldingTab key={tab.id} tab={tab} />;
        const index = session.tabs.indexOf(tab);
        const page = currentPage(tab);
        const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
          if (event.key === "Delete") {
            event.preventDefault();
            onClose(tab.id);
            return;
          }
          const next = nextTab(session, index, event.key);
          if (!next) return;
          event.preventDefault();
          onSelect(next.id);
          document.getElementById(`panel-tab-${next.id}`)?.focus();
        };
        const props = { tab, page, active: tab.id === session.activeId, onSelect, onClose, onKeyDown };
        return page.kind === "file" && page.selection ? <FileTab key={tab.id} {...props} selection={page.selection} /> : <PanelTab key={tab.id} {...props} unsaved={false} />;
      })}
    </div>
  );
}
