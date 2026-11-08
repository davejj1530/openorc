import { useLayout } from "../lib/layout";
import { PanelIcon } from "./icons";
import { PanelSideSwitch } from "./PanelSideSwitch";
import { IconButton, Tooltip } from "./ui";

export function ThreadTools({ threadId }: { threadId: string }) {
  const activeTab = useLayout((state) => (state.panelOpen && state.panelThreadId === threadId ? state.panelTab : null));
  const side = useLayout((state) => state.panelSide);
  const toggleLabel = activeTab ? "Hide panel" : "Show panel";
  return (
    <div className="thread-rail-tools" role="group" aria-label="Thread tools">
      {activeTab ? <PanelSideSwitch docked="right" /> : null}
      <Tooltip label={toggleLabel}>
        <IconButton aria-label={toggleLabel} aria-pressed={activeTab !== null} onClick={() => useLayout.getState().toggleThreadPanel(threadId)}>
          <PanelIcon side={side} size={16} />
        </IconButton>
      </Tooltip>
    </div>
  );
}
