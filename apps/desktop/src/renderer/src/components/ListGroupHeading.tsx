import type { ReactNode } from "react";
import { ChevronDown } from "./icons";

/** A list group's sticky heading: its name in ink and a faint count. It folds the group's rows; the chevron shows on hover and while folded. */
export function ListGroupHeading({
  id,
  controls,
  collapsed,
  onToggle,
  icon,
  label,
  count,
}: {
  id: string;
  controls: string;
  collapsed: boolean;
  onToggle: () => void;
  icon?: ReactNode;
  label: string;
  /** Null while the group's rows are still loading. */
  count: { value: number; label: string } | null;
}) {
  return (
    <h2 className="list-group-heading well-fill sticky top-0 z-10">
      <button type="button" id={id} aria-expanded={!collapsed} aria-controls={controls} onClick={onToggle} className="list-group-header">
        {icon}
        <span className="truncate text-ink">{label}</span>
        {count ? (
          <span className="text-sm text-ink-4 tabular" aria-label={count.label}>
            {count.value}
          </span>
        ) : null}
        <ChevronDown size={12} aria-hidden="true" className="list-group-chevron" />
      </button>
    </h2>
  );
}
