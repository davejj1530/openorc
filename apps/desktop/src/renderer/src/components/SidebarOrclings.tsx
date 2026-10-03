import type { Orcling } from "@openorc/protocol";
import { useState } from "react";
import { cn } from "../lib/cn";
import { useLayout } from "../lib/layout";
import { messagePreview } from "../lib/message-preview";
import { useOrclings } from "../lib/orclings";
import { useRpc } from "../lib/query";
import { useRouter, type Route } from "../lib/router";
import { Plus, Search } from "./icons";
import { PanelLeft } from "./icons";
import { OrclingAvatar } from "./OrclingAvatar";
import { ThreadStatusIndicator } from "./ThreadStatusIndicator";
import { IconButton, Tooltip } from "./ui";
import { dismissCompactNavigation } from "../lib/compact-navigation";

/** The Orclings destination replaces the project thread list in the same sidebar. */
export function SidebarOrclings({ route }: { route: Route }) {
  const orclings = useOrclings();
  const activeId = route.view === "thread" ? route.threadId : null;
  const [search, setSearch] = useState("");
  const filtered = orclings.filter((orcling) => orcling.name.toLowerCase().includes(search.toLowerCase()));
  return (
    <section className="conversation-browser orcling-browser" aria-label="Orclings">
      <header className="browser-toolbar drag-region h-topbar">
        <span className="browser-close">
          <IconButton aria-label="Toggle sidebar" onClick={() => useLayout.getState().toggleSidebar()} className="no-drag">
            <PanelLeft size={15} />
          </IconButton>
        </span>
        <span>Orclings</span>
        <Tooltip label="New Orcling">
          <IconButton onClick={() => useRouter.getState().navigate({ view: "orcling" })} aria-label="New Orcling" size="sm" className="no-drag">
            <Plus size={14} />
          </IconButton>
        </Tooltip>
      </header>
      <div className="browser-heading">
        <h2>Your Orclings</h2>
        <p>A conversation with each companion</p>
      </div>
      <div className="browser-controls">
        <label className="browser-search">
          <Search size={14} />
          <input aria-label="Find an Orcling" placeholder="Find an Orcling…" value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
      </div>
      <div className="browser-threads">
        {filtered.map((orcling) => (
          <OrclingRow key={orcling.id} orcling={orcling} active={activeId === orcling.threadId} />
        ))}
        {!filtered.length ? <p className="browser-empty">{search ? "No matching Orclings." : "Create an Orcling to start a conversation."}</p> : null}
      </div>
      <p className="browser-hint">Each Orcling keeps its own instructions and memory.</p>
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
        dismissCompactNavigation();
      }}
      aria-current={active ? "page" : undefined}
      title={orcling.name}
      className={cn("orcling-contact no-drag min-w-0 text-ink-2 transition-colors hover:text-ink", (active || attention) && "text-ink")}
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
