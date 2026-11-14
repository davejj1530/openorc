import { SpaceSwitcher } from "./SpaceSwitcher";
import type { ReactNode } from "react";
import { ArrowLeft, ArrowRight, PanelLeft } from "./icons";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import { useLayout } from "../lib/layout";
import { useSidebarHistory } from "../lib/sidebar-history";
import { cn } from "../lib/cn";
import { useRouter } from "../lib/router";
import { IconButton, Tooltip, type IconSize } from "./ui";

/**
 * The window's corner: the sidebar toggle. It leads the first header beside the sidebar, open or hidden: the main
 * column's, or a panel's docked on the left. Back and Forward follow the toggle here when
 * the sidebar is hidden or its whole space name leaves too little room for them.
 */
export function WindowCorner({ sidebarOpen }: { sidebarOpen: boolean }) {
  const historyFits = useSidebarHistory((state) => state.fits);
  return (
    <div className="window-corner" role="group" aria-label="Window">
      <SidebarToggle open={sidebarOpen} />
      {sidebarOpen ? null : <SpaceSwitcher hidden />}
      {!sidebarOpen || !historyFits ? <HistoryButtons size="lg" /> : null}
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
