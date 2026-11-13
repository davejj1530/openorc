import type { ReactNode } from "react";
import { ChevronDown } from "./icons";
import { cn } from "../lib/cn";

/** A list group's sticky heading: its name in ink and a faint count, or an amber one of what waits on the person. It folds the group's rows; the chevron shows on hover and while folded. */
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
  /** Null while the group's rows are still loading. A count of what waits on the person is amber. */
  count: { value: number; label: string; waiting?: boolean } | null;
}) {
  return (
    <h2 className="list-group-heading well-fill sticky top-0 z-10">
      <button type="button" id={id} aria-expanded={!collapsed} aria-controls={controls} onClick={onToggle} className="list-group-header">
        {icon}
        <span className="truncate text-ink">{label}</span>
        {count ? (
          <span className={cn("text-sm tabular", count.waiting ? "text-attention" : "text-ink-4")} aria-label={count.label}>
            {count.value}
          </span>
        ) : null}
        <ChevronDown size={12} aria-hidden="true" className="list-group-chevron" />
      </button>
    </h2>
  );
}
