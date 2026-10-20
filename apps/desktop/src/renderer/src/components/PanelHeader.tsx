import { Expand, PanelRight, Plus, Shrink } from "./icons";
import { IconButton, Tooltip } from "./ui";
import { cn } from "../lib/cn";
import { useLayout } from "../lib/layout";
import { usePanelSessions, type PanelSession } from "../lib/panel-tabs";
import { PanelTabs } from "./PanelTabs";

/**
 * The top of the panel card: the tab track, the plus that adds a New tab page, then expand and
 * hide. It sits 52px tall inside the card, or on the 44px window chrome line when it clears the
 * native window controls (`chrome`), padded past whichever controls it shares the line with.
 */
export function PanelHeader({
  scope,
  session,
  expanded,
  chrome,
  trafficClearance,
  windowsControls,
  onClose,
}: {
  scope: string;
  session: PanelSession;
  expanded: boolean;
  chrome: boolean;
  trafficClearance: boolean;
  windowsControls: boolean;
  onClose: (id: string) => void;
}) {
  return (
    <header
      data-traffic-clearance={trafficClearance || undefined}
      className={cn("panel-header drag-region", chrome && "panel-header-chrome", expanded && trafficClearance ? "pl-traffic" : "pl-2.5", windowsControls ? "pr-controls" : "pr-2")}
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
        <IconButton aria-label="Hide panel" className="no-drag" onClick={() => useLayout.getState().setPanel(false)}>
          <PanelRight size={16} />
        </IconButton>
      </Tooltip>
    </header>
  );
}
