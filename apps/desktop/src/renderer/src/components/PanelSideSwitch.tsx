import { useLayout, type PanelSide } from "../lib/layout";
import { ArrowLeftRight } from "./icons";
import { IconButton, Tooltip } from "./ui";

/**
 * Moves the open panel to the other side of the work row. It sits in whichever column is in the middle, beside the
 * seam it moves: the main column's header while the panel docks on the right, the panel's own header on the left.
 * Each places it for one side, `docked`, and it shows only while the panel docks there.
 */
export function PanelSideSwitch({ docked }: { docked: PanelSide }) {
  const side = useLayout((state) => state.panelSide);
  if (side !== docked) return null;
  const label = side === "left" ? "Move panel right" : "Move panel left";
  return (
    <Tooltip label={label}>
      <IconButton aria-label={label} className="no-drag" onClick={() => useLayout.getState().togglePanelSide()}>
        <ArrowLeftRight size={16} />
      </IconButton>
    </Tooltip>
  );
}
