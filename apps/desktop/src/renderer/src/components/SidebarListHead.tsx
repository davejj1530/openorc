import { useRef, useState, type ReactNode } from "react";
import { Search, X } from "./icons";
import { useSlidingKnob } from "../lib/use-sliding-knob";

export type SidebarList = "threads" | "orclings";

/**
 * The head of the sidebar's list: Threads and Orclings at their natural width on a track with a
 * sliding knob, then a round search button and the list's own tool (filter, or New Orcling). While
 * searching, the field grows over the tabs; it folds back when closed or left empty.
 */
export function SidebarListHead({
  list,
  onList,
  search,
  onSearch,
  searchLabel,
  placeholder,
  tool,
}: {
  list: SidebarList;
  onList: (list: SidebarList) => void;
  search: string;
  onSearch: (value: string) => void;
  /** The field's accessible name. */
  searchLabel: string;
  placeholder: string;
  tool: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const knob = useSlidingKnob(tabs, '[aria-current="page"]', list);
  const searching = expanded || search !== "";
  const close = () => {
    onSearch("");
    setExpanded(false);
  };
  return (
    <div className="sidebar-list-head" data-searching={searching || undefined}>
      <div ref={tabs} className="segmented sidebar-list-tabs" aria-label="Conversations" role="group" inert={searching}>
        <span aria-hidden="true" className="segmented-knob" data-placed={knob.placed || undefined} hidden={!knob.style} style={knob.style} />
        <button type="button" className="segmented-option sidebar-list-tab no-drag" aria-current={list === "threads" ? "page" : undefined} onClick={() => onList("threads")}>
          Threads
        </button>
        <button type="button" className="segmented-option sidebar-list-tab no-drag" aria-current={list === "orclings" ? "page" : undefined} onClick={() => onList("orclings")}>
          Orclings
        </button>
      </div>
      <div className="sidebar-search">
        <button
          type="button"
          className="sidebar-search-glass no-drag"
          aria-label={placeholder}
          aria-expanded={searching}
          tabIndex={searching ? -1 : undefined}
          onClick={() => {
            setExpanded(true);
            input.current?.focus();
          }}
        >
          <Search size={14} />
        </button>
        <input
          ref={input}
          className="sidebar-search-input native-field no-drag"
          aria-label={searchLabel}
          placeholder={placeholder}
          value={search}
          tabIndex={searching ? undefined : -1}
          onFocus={() => setExpanded(true)}
          onBlur={() => {
            if (!search) setExpanded(false);
          }}
          onChange={(event) => onSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            close();
            input.current?.blur();
          }}
        />
        <button
          type="button"
          className="sidebar-search-close no-drag"
          aria-label="Close search"
          tabIndex={searching ? undefined : -1}
          aria-hidden={!searching}
          onMouseDown={(event) => event.preventDefault()}
          onClick={close}
        >
          <X size={14} />
        </button>
      </div>
      <div className="sidebar-list-tool">{tool}</div>
    </div>
  );
}
