import type { ReactNode } from "react";
import { ArrowLeft, PanelLeft } from "./icons";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import { useLayout } from "../lib/layout";
import { cn } from "../lib/cn";
import { useRouter } from "../lib/router";
import { IconButton, Tooltip } from "./ui";

/**
 * The window's corner: the sidebar toggle, then Back. It leads the first header beside the sidebar, open or hidden: the
 * main column's, or a panel's docked on the left. Forward stays on ⌘].
 */
export function WindowCorner({ sidebarOpen }: { sidebarOpen: boolean }) {
  const canBack = useRouter((s) => s.history.length > 0);
  return (
    <div className="window-corner" role="group" aria-label="Window">
      <SidebarToggle open={sidebarOpen} />
      <HistoryButton label="Back" disabled={!canBack} onClick={() => useRouter.getState().back()}>
        <ArrowLeft size={16} />
      </HistoryButton>
    </div>
  );
}

/** One step back through the window's history, the same as ⌘[. */
function HistoryButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip label={label}>
      <IconButton
        size="lg"
        disabled={disabled}
        onClick={() => {
          onClick();
          dismissCompactNavigation();
        }}
        aria-label={label}
        className="no-drag"
      >
        {children}
      </IconButton>
    </Tooltip>
  );
}

/** Shows or hides the sidebar. */
export function SidebarToggle({ open, className }: { open: boolean; className?: string }) {
  const toggle = useLayout((s) => s.toggleSidebar);
  return (
    <Tooltip label={open ? "Hide sidebar" : "Show sidebar"}>
      <IconButton size="lg" onClick={toggle} aria-label="Toggle sidebar" className={cn("no-drag", className)}>
        <PanelLeft size={16} />
      </IconButton>
    </Tooltip>
  );
}
