import { useId, type ReactNode } from "react";
import { useLayout } from "../lib/layout";
import { ChevronDown, ChevronRight } from "./icons";

/** Project disclosures share saved layout state; a single-project view always shows its rows. */
export function SidebarProjectGroup({ id, name, collapsible, children }: { id: string; name: string; collapsible: boolean; children: ReactNode }) {
  const collapsed = useLayout((state) => state.collapsed);
  const toggle = useLayout((state) => state.toggleCollapsed);
  const contentId = useId();
  const expanded = !collapsible || !collapsed.includes(`project:${id}`);
  return (
    <section aria-label={`${name} threads`}>
      {collapsible ? (
        <h3 className="browser-group-title">
          <button
            type="button"
            className="browser-group-toggle"
            aria-label={`${expanded ? "Collapse" : "Expand"} ${name} threads`}
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={() => toggle(`project:${id}`)}
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span>{name}</span>
          </button>
        </h3>
      ) : null}
      <div id={contentId} hidden={!expanded}>
        {children}
      </div>
    </section>
  );
}
