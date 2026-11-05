import { useRef, useState, type ReactNode } from "react";
import { Search, X } from "./icons";

/**
 * The head of the sidebar's list: its name, then a round search button and the list's own tools
 * (filter, Add project and New thread, or New Orcling). While searching, the field grows leftward
 * over the name; it folds back when closed or left empty. The tools stay where they are.
 */
export function SidebarListHead({
  title,
  search,
  onSearch,
  searchLabel,
  placeholder,
  tools,
}: {
  title: string;
  search: string;
  onSearch: (value: string) => void;
  /** The field's accessible name. */
  searchLabel: string;
  placeholder: string;
  tools: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const searching = expanded || search !== "";
  const close = () => {
    onSearch("");
    setExpanded(false);
  };
  return (
    <div className="sidebar-list-head" data-searching={searching || undefined}>
      <div className="sidebar-list-lead">
        <span className="sidebar-list-title" aria-hidden={searching}>
          {title}
        </span>
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
            <Search size={16} />
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
      </div>
      <div className="sidebar-list-tools">{tools}</div>
    </div>
  );
}
