import type { Orcling } from "@openorc/protocol";
import { cn } from "../lib/cn";
import { useLayout } from "../lib/layout";
import { messagePreview } from "../lib/message-preview";
import { useOrclings } from "../lib/orclings";
import { useRpc } from "../lib/query";
import { useRouter, type Route } from "../lib/router";
import { Plus } from "./icons";
import { OrclingAvatar } from "./OrclingAvatar";
import { ThreadStatusIndicator } from "./ThreadStatusIndicator";
import { IconButton, Tooltip } from "./ui";

/** Your Orclings above your projects: each opens its own conversation. */
export function SidebarOrclings({ route }: { route: Route }) {
  const orclings = useOrclings();
  const activeId = route.view === "thread" ? route.threadId : null;
  return (
    <section className="sidebar-orclings mt-4" aria-label="Orclings">
      <div className="flex items-center gap-0.5 pl-4 pr-2 mb-1">
        <span className="text-sm font-medium text-ink-3">Orclings</span>
        <span className="flex-1" />
        <Tooltip label="New Orcling">
          <IconButton onClick={() => useRouter.getState().navigate({ view: "orcling" })} aria-label="New Orcling" size="sm" className="no-drag">
            <Plus size={14} />
          </IconButton>
        </Tooltip>
      </div>
      <div className="grid grid-cols-1 min-w-0 gap-px px-2">
        {orclings.map((orcling) => (
          <OrclingRow key={orcling.id} orcling={orcling} active={activeId === orcling.threadId} />
        ))}
      </div>
    </section>
  );
}

/** An Orcling as a chat list shows a contact: its face, its name, and the last thing said in its conversation. */
function OrclingRow({ orcling, active }: { orcling: Orcling; active: boolean }) {
  const thread = useRpc("threads.get", { id: orcling.threadId });
  const last = useRpc("threads.lastMessage", { id: orcling.threadId }).data;
  const attention = Boolean(thread.data?.unread || thread.data?.activity === "waiting");
  const preview = last ? messagePreview(last.text) : "";
  return (
    <button
      type="button"
      onClick={() => {
        useLayout.getState().setProject(thread.data?.projectId ?? null);
        useRouter.getState().navigate({ view: "thread", threadId: orcling.threadId });
      }}
      aria-current={active ? "page" : undefined}
      title={orcling.name}
      className={cn(
        "sidebar-thread-row no-drag min-w-0 w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md text-base text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink",
        (active || attention) && "text-ink",
      )}
    >
      <OrclingAvatar orcling={orcling} size={36} className="shrink-0" />
      <span className="flex flex-1 min-w-0 flex-col text-left">
        <span className="flex min-w-0 items-center">
          <span className="flex-1 min-w-0 truncate">{orcling.name}</span>
          {thread.data ? <ThreadStatusIndicator thread={thread.data} /> : null}
        </span>
        {preview ? <span className="truncate text-sm text-ink-3">{last?.role === "user" ? `You: ${preview}` : preview}</span> : null}
      </span>
    </button>
  );
}
