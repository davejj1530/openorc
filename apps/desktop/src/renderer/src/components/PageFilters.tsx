import type { ReactNode } from "react";
import { Search } from "./icons";

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
