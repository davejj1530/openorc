import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/** A page's heading in its header. Every page's title starts on one line, 4px into the header's own padding. */
export function PageTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h1 className={cn("inline-flex h-7 min-w-0 items-center px-1 truncate text-ink", className)}>{children}</h1>;
}

/** A page under another, as in "Tasks / Create the welcome flow": the parent's name goes back to it. */
export function PageCrumbs({ parent, onParent, children }: { parent: string; onParent: () => void; children: ReactNode }) {
  return (
    <span className="title-crumbs">
      <button type="button" className="title-crumb-link no-drag" onClick={onParent}>
        {parent}
      </button>
      <span aria-hidden="true" className="title-crumb-divider">
        /
      </span>
      <span className="inline-flex min-w-0 items-center gap-2 text-ink">{children}</span>
    </span>
  );
}
