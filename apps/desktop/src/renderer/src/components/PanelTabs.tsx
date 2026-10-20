import { useEffect, useRef, type KeyboardEvent } from "react";
import type { FileSelection } from "../lib/layout";
import { currentPage, type PanelPage, type PanelSession, type WorkTab } from "../lib/panel-tabs";
import { useSlidingKnob } from "../lib/use-sliding-knob";
import { useUnsavedFile } from "../lib/use-file-buffer";
import { pageIcon, pageLabel } from "./panel-tools";
import { X } from "./icons";

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

/**
 * One tab at its natural width. Its mark (the tool's glyph, or a dot while a file has unsaved
 * edits) turns into the close control under the pointer or keyboard focus.
 */
function PanelTab({ tab, page, active, unsaved, onSelect, onClose, onKeyDown }: TabProps & { unsaved: boolean }) {
  const label = pageLabel(page);
  const Icon = pageIcon(page);
  return (
    <div role="presentation" className="panel-tab" data-active={active}>
      <button
        role="tab"
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
        <span className="panel-tab-mark" aria-hidden="true">
          {unsaved ? <span className="panel-tab-dot" /> : <Icon size={14} />}
        </span>
        <span className="panel-tab-label">{label}</span>
      </button>
      <button className="panel-tab-close" aria-label={`Close ${label}`} title={`Close ${label}`} onClick={() => onClose(tab.id)}>
        <X size={12} />
      </button>
    </div>
  );
}

function FileTab({ selection, ...props }: TabProps & { selection: FileSelection }) {
  return <PanelTab {...props} unsaved={useUnsavedFile(selection)} />;
}

/**
 * The panel's tabs on a fill track with a sliding knob under the open one. The track scrolls
 * sideways when the tabs outgrow it; the knob scrolls with it and the open tab is kept in view.
 */
export function PanelTabs({ session, onSelect, onClose }: { session: PanelSession; onSelect: (id: string) => void; onClose: (id: string) => void }) {
  const strip = useRef<HTMLDivElement>(null);
  const knob = useSlidingKnob(strip, '.panel-tab[data-active="true"]', `${session.activeId}:${session.tabs.length}`);
  useEffect(() => {
    strip.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [session.activeId]);
  return (
    <div ref={strip} role="tablist" aria-label="Panel tabs" className="panel-tabs no-drag" data-placed={knob.placed || undefined}>
      <span aria-hidden="true" className="panel-tabs-knob" data-placed={knob.placed || undefined} hidden={!knob.style} style={knob.style} />
      {session.tabs.map((tab, index) => {
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
