import type { ReactNode } from "react";
import { ArrowLeft, ArrowRight, PanelLeft } from "./icons";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import { useLayout } from "../lib/layout";
import { useRouter } from "../lib/router";
import { IconButton, Tooltip } from "./ui";

/**
 * The window's corner: Back, Forward and the sidebar toggle. It sits in the sidebar's header while the
 * sidebar is open and in the main column's header while it is hidden. Search lives in the sidebar's
 * list head and Inbox on the rail.
 */
export function WindowCorner({ sidebarOpen }: { sidebarOpen: boolean }) {
  const canBack = useRouter((s) => s.history.length > 0);
  const canForward = useRouter((s) => s.future.length > 0);
  return (
    <div className="window-corner" role="group" aria-label="Window">
      <HistoryButton label="Back" disabled={!canBack} onClick={() => useRouter.getState().back()}>
        <ArrowLeft size={16} />
      </HistoryButton>
      <HistoryButton label="Forward" disabled={!canForward} onClick={() => useRouter.getState().forward()}>
        <ArrowRight size={16} />
      </HistoryButton>
      <SidebarToggle open={sidebarOpen} />
    </div>
  );
}

/** One step through the window's history, the same as ⌘[ and ⌘]. */
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
function SidebarToggle({ open }: { open: boolean }) {
  const toggle = useLayout((s) => s.toggleSidebar);
  return (
    <Tooltip label={open ? "Hide sidebar" : "Show sidebar"}>
      <IconButton size="lg" onClick={toggle} aria-label="Toggle sidebar" className="no-drag">
        <PanelLeft size={16} />
      </IconButton>
    </Tooltip>
  );
}
