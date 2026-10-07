import { useEffect, useRef } from "react";
import { currentPage, pageType, type PanelSession, type WorkTab } from "../lib/panel-tabs";
import { pageLabel, panelTools } from "./panel-tools";
import { X } from "./icons";

function nextTab(session: PanelSession, index: number, key: string): WorkTab | undefined {
  if (key === "Home") return session.tabs[0];
  if (key === "End") return session.tabs.at(-1);
  if (key === "ArrowRight") return session.tabs[(index + 1) % session.tabs.length];
  if (key === "ArrowLeft") return session.tabs[(index - 1 + session.tabs.length) % session.tabs.length];
  return undefined;
}

export function PanelTabs({ session, onSelect, onClose }: { session: PanelSession; onSelect: (id: string) => void; onClose: (id: string) => void }) {
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    strip.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [session.activeId]);
  return (
    <div ref={strip} role="tablist" aria-label="Panel tabs" className="panel-browser-tabs no-drag">
      {session.tabs.map((tab, index) => {
        const page = currentPage(tab);
        const label = pageLabel(page);
        const Icon = panelTools[pageType(page)].icon;
        const active = tab.id === session.activeId;
        return (
          <div key={tab.id} role="presentation" className="panel-browser-tab" data-active={active}>
            <button
              role="tab"
              id={`panel-tab-${tab.id}`}
              aria-controls="panel-tab-content"
              aria-label={label}
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
              onKeyDown={(event) => {
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
              }}
            >
              <Icon size={14} />
              <span>{label}</span>
            </button>
            <button className="panel-tab-close" aria-label={`Close ${label}`} title={`Close ${label}`} onClick={() => onClose(tab.id)}>
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
