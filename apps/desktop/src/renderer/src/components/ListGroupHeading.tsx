import type { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "./icons";
import { cn } from "../lib/cn";

/** A list group's sticky heading. It collapses the group's rows and says how many there are. */
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
  icon: ReactNode;
  label: string;
  /** Null while the group's rows are still loading. */
  count: { value: number; label: string } | null;
}) {
  return (
    <h2 className="list-group-heading well-fill sticky top-0 z-10 mx-3 pt-2">
      <button
        type="button"
        id={id}
        aria-expanded={!collapsed}
        aria-controls={controls}
        onClick={onToggle}
        className={cn("list-group-header w-full flex items-center gap-2 h-8 px-3 text-left text-sm font-medium text-ink-2", collapsed ? "rounded-md" : "rounded-t-md")}
      >
        {collapsed ? <ChevronRight size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
        {icon}
        {label}
        {count ? (
          <span className="text-ink-4 tabular" aria-label={count.label}>
            {count.value}
          </span>
        ) : null}
      </button>
    </h2>
  );
}
