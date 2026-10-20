import { useLayout } from "../lib/layout";
import { ListTodo, PanelRight } from "./icons";
import { IconButton, Tooltip } from "./ui";

export function ThreadTools({ threadId }: { threadId: string }) {
  const activeTab = useLayout((state) => (state.panelOpen && state.panelThreadId === threadId ? state.panelTab : null));
  const toggleLabel = activeTab ? "Hide panel" : "Show panel";
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
      <Tooltip label={toggleLabel}>
        <IconButton aria-label={toggleLabel} aria-pressed={activeTab !== null} onClick={() => useLayout.getState().toggleThreadPanel(threadId)}>
          <PanelRight size={16} />
        </IconButton>
      </Tooltip>
    </div>
  );
}
