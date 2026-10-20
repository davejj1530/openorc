import { Expand, PanelRight, Plus, Shrink } from "./icons";
import { IconButton, Tooltip } from "./ui";
import { cn } from "../lib/cn";
import { useLayout } from "../lib/layout";
import { usePanelSessions, type PanelSession } from "../lib/panel-tabs";
import { PanelTabs } from "./PanelTabs";

/**
 * The panel's row on the window's chrome line, above its card: the tab track, the plus that adds
 * a New tab page, then expand and hide. It lines up with the thread header beside it and pads past
 * whichever native window controls it shares the line with. Hide shows only while the panel
 * covers the thread header and its panel toggle: expanded, or floating over a narrow work row.
 */
export function PanelHeader({
  scope,
  session,
  expanded,
  trafficClearance,
  windowsControls,
  onClose,
}: {
  scope: string;
  session: PanelSession;
  expanded: boolean;
  trafficClearance: boolean;
  windowsControls: boolean;
  onClose: (id: string) => void;
}) {
  return (
    <header
      data-traffic-clearance={trafficClearance || undefined}
      // The tabs start at the card's left edge: flush when docked, past its 8px gutter or the traffic lights when expanded.
      className={cn("panel-header drag-region", expanded && (trafficClearance ? "pl-traffic" : "pl-2"), windowsControls ? "pr-controls" : "pr-2")}
    >
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
          <PanelRight size={16} />
        </IconButton>
      </Tooltip>
    </header>
  );
}
