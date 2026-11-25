import type { ReactNode } from "react";
import { ArrowLeft, ArrowRight, PanelLeft } from "./icons";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import { useLayout } from "../lib/layout";
import { cn } from "../lib/cn";
import { useRouter } from "../lib/router";
import { IconButton, Tooltip, type IconSize } from "./ui";

/**
 * The window's corner while the sidebar is hidden: the toggle that brings it back, on the spot the sidebar's own
 * header keeps it, then Back and Forward. It leads the window's first header: the main column's, or a panel's docked
 * on the left. While the sidebar shows, its header holds all three.
 */
export function WindowCorner({ sidebarOpen, className }: { sidebarOpen: boolean; className?: string }) {
  if (sidebarOpen) return null;
  return (
    <div className={cn("window-corner", className)} role="group" aria-label="Window">
      <SidebarToggle open={false} />
      <HistoryButtons size="lg" />
    </div>
  );
}

/** Back and Forward through the window's history, the same as ⌘[ and ⌘]. Each is off while there is nowhere to go. */
export function HistoryButtons({ size, className }: { size: IconSize; className?: string }) {
  const canBack = useRouter((s) => s.history.length > 0);
  const canForward = useRouter((s) => s.future.length > 0);
  return (
    <div className={cn("history-buttons", className)} role="group" aria-label="History">
      <HistoryButton size={size} label="Back" disabled={!canBack} onClick={() => useRouter.getState().back()}>
        <ArrowLeft size={16} />
      </HistoryButton>
      <HistoryButton size={size} label="Forward" disabled={!canForward} onClick={() => useRouter.getState().forward()}>
        <ArrowRight size={16} />
      </HistoryButton>
    </div>
  );
}

function HistoryButton({ size, label, disabled, onClick, children }: { size: IconSize; label: string; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip label={label}>
      <IconButton
        size={size}
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
export function SidebarToggle({ open }: { open: boolean }) {
  const toggle = useLayout((s) => s.toggleSidebar);
  return (
    <Tooltip label={open ? "Hide sidebar" : "Show sidebar"}>
      <IconButton size="lg" onClick={toggle} aria-label="Toggle sidebar" className="no-drag">
        <PanelLeft size={16} />
      </IconButton>
    </Tooltip>
  );
}
