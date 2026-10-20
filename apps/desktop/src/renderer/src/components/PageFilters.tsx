import { useState, type ReactNode } from "react";
import { Search } from "./icons";
import { IconButton } from "./ui";

/**
 * The row under a page's title bar, the same on every list page: tabs on the
 * left, then the page's filters, with search or a view switch at the far end.
 * The filters and the end slot wrap together onto a second line when narrow.
 */
export function PageFilters({ tabs, end, children }: { tabs?: ReactNode; end?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-filters">
      {tabs}
      <div className="page-filter-tools">
        {children}
        {end ? <div className="page-filter-end">{end}</div> : null}
      </div>
    </div>
  );
}

/** The filter row's search field: a lens and a borderless input. */
export function PageSearch({ label, placeholder, value, onChange }: { label: string; placeholder: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="page-search">
      <Search size={13} className="shrink-0" />
      <input aria-label={label} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

/**
 * A page header's search: a round control that grows into a field. The field stays open while
 * it holds a query; Escape clears it and folds it back.
 */
export function HeaderSearch({ label, placeholder, value, onChange }: { label: string; placeholder: string; value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!open && !value)
    return (
      <IconButton aria-label={label} onClick={() => setOpen(true)}>
        <Search size={15} />
      </IconButton>
    );
  return (
    <label className="header-search-field no-drag">
      <Search size={14} className="shrink-0" />
      <input
        autoFocus={open}
        aria-label={label}
        className="native-field"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => {
          if (!value) setOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          onChange("");
          setOpen(false);
        }}
      />
    </label>
  );
}
