import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import "./PanelBar.css";

/**
 * A panel tool's bar under the tabs: a title, its faint meta, then the tool's actions at the end.
 * Borderless; the tool's content starts right under it.
 */
export function PanelBar({ title, meta, children, className }: { title: ReactNode; meta?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("panel-bar", className)}>
      <div className="panel-bar-title">{title}</div>
      {meta}
      <span className="flex-1" />
      {children}
    </div>
  );
}

/** Faint meta beside a bar's title, such as a count. */
export function PanelBarMeta({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span className={cn("panel-bar-meta", className)} title={title}>
      {children}
    </span>
  );
}

/** Added and removed line counts in mono, each in its own tone. Nothing when there are none. */
export function DiffStat({ add, del }: { add: number; del: number }) {
  if (add + del === 0) return null;
  return (
    <span className="panel-bar-stat tabular">
      <span className="text-ok">+{add}</span>
      <span className="text-bad">-{del}</span>
    </span>
  );
}

/** A line of status or error text under a bar, without a border. */
export function PanelNotice({ children, tone = "muted", role = "status", className }: { children: ReactNode; tone?: "muted" | "bad"; role?: "status" | "alert"; className?: string }) {
  return (
    <div role={role} className={cn("panel-notice", tone === "bad" && "text-bad", className)}>
      {children}
    </div>
  );
}
