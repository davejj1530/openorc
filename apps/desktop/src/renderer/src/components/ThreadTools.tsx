import { useLayout } from "../lib/layout";
import { ListTodo, PanelRight } from "./icons";
import { IconButton, Tooltip } from "./ui";

export function ThreadTools({ threadId }: { threadId: string }) {
  const activeTab = useLayout((state) => (state.panelOpen && state.panelThreadId === threadId ? state.panelTab : null));
  return (
    <div className="thread-rail-tools" role="group" aria-label="Thread tools">
      {(
        [
          ["tasks", "Tasks", ListTodo],
          ["changes", "Changes", PanelRight],
        ] as const
      ).map(([tab, label, Icon]) => (
        <Tooltip key={tab} label={label}>
          <IconButton
            aria-label={label}
            aria-pressed={activeTab === tab}
            onClick={() => {
              const layout = useLayout.getState();
              if (activeTab === tab) layout.toggleThreadPanel(threadId);
              else layout.openThreadPanel(threadId, tab);
            }}
          >
            <Icon size={15} />
          </IconButton>
        </Tooltip>
      ))}
    </div>
  );
}
