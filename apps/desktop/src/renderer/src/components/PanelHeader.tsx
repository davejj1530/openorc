import { Expand, PanelIcon, Plus, Shrink } from "./icons";
import { IconButton, Tooltip } from "./ui";
import { cn } from "../lib/cn";
import { useLayout, type PanelSide } from "../lib/layout";
import { usePanelSessions, type PanelSession } from "../lib/panel-tabs";
import { PanelTabs } from "./PanelTabs";
import { WindowCorner } from "./WindowCorner";

/**
 * The panel's row on the window's chrome line, above its card: the tab track, the plus that adds
 * a New tab page, then expand and hide. It lines up with the thread header beside it and pads past
 * whichever native window controls it shares the line with. Hide shows only while the panel
 * covers the thread header and its panel toggle: expanded, or floating over a narrow work row.
 * Docked on the left it is the window's first header, so the window corner moves here while the
 * sidebar is hidden.
 */
export function PanelHeader({
  scope,
  session,
  side,
  expanded,
  sidebarOpen,
  trafficClearance,
  windowsControls,
  onClose,
}: {
  scope: string;
  session: PanelSession;
  side: PanelSide;
  expanded: boolean;
  sidebarOpen: boolean;
  trafficClearance: boolean;
  windowsControls: boolean;
  onClose: (id: string) => void;
}) {
  const left = side === "left";
  const outerLeft = left || expanded;
  const outerRight = !left || expanded;
  return (
    <header
      data-traffic-clearance={trafficClearance || undefined}
      // The row lines up with the card under it: flush with the card's edge beside the conversation,
      // and past its 8px gutter, the traffic lights or the Windows controls at the window's edges.
      className={cn("panel-header drag-region", outerLeft && (trafficClearance ? "pl-traffic" : "pl-2"), outerRight && (windowsControls ? "pr-controls" : "pr-2"))}
    >
      {left ? (
        <span className="workspace-window-nav flex items-center" data-sidebar-open={sidebarOpen}>
          <WindowCorner sidebarOpen={sidebarOpen} />
        </span>
      ) : null}
      <PanelTabs key={scope} session={session} onSelect={(id) => usePanelSessions.getState().select(scope, id)} onClose={onClose} />
      <Tooltip label="New tab">
        <IconButton aria-label="New tab" className="panel-add no-drag hover-step size-9 bg-control-fill hover:bg-control-fill" onClick={() => usePanelSessions.getState().add(scope)}>
          <Plus size={15} />
        </IconButton>
      </Tooltip>
      <span className="flex-1" />
      <Tooltip label={expanded ? "Collapse panel" : "Expand panel"}>
        <IconButton aria-label={expanded ? "Collapse panel" : "Expand panel"} aria-pressed={expanded} className="no-drag" onClick={() => useLayout.getState().setPanelExpanded(!expanded)}>
          {expanded ? <Shrink size={15} /> : <Expand size={15} />}
        </IconButton>
      </Tooltip>
      <Tooltip label="Hide panel">
        <IconButton aria-label="Hide panel" className="panel-hide no-drag" onClick={() => useLayout.getState().setPanel(false)}>
          <PanelIcon side={side} size={16} />
        </IconButton>
      </Tooltip>
    </header>
  );
}
