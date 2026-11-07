import { useLayout } from "../lib/layout";
import { ArrowLeftRight, ListTodo, PanelIcon } from "./icons";
import { IconButton, Tooltip } from "./ui";

export function ThreadTools({ threadId }: { threadId: string }) {
  const activeTab = useLayout((state) => (state.panelOpen && state.panelThreadId === threadId ? state.panelTab : null));
  const side = useLayout((state) => state.panelSide);
  const toggleLabel = activeTab ? "Hide panel" : "Show panel";
  const swapLabel = side === "left" ? "Move panel right" : "Move panel left";
  return (
    <div className="thread-rail-tools" role="group" aria-label="Thread tools">
      <Tooltip label="Tasks">
        <IconButton
          aria-label="Tasks"
          aria-pressed={activeTab === "tasks"}
          onClick={() => {
            const layout = useLayout.getState();
            if (activeTab === "tasks") layout.toggleThreadPanel(threadId);
            else layout.openThreadPanel(threadId, "tasks");
          }}
        >
          <ListTodo size={16} />
        </IconButton>
      </Tooltip>
      {activeTab ? (
        <Tooltip label={swapLabel}>
          <IconButton aria-label={swapLabel} onClick={() => useLayout.getState().togglePanelSide()}>
            <ArrowLeftRight size={16} />
          </IconButton>
        </Tooltip>
      ) : null}
      <Tooltip label={toggleLabel}>
        <IconButton aria-label={toggleLabel} aria-pressed={activeTab !== null} onClick={() => useLayout.getState().toggleThreadPanel(threadId)}>
          <PanelIcon side={side} size={16} />
        </IconButton>
      </Tooltip>
    </div>
  );
}
