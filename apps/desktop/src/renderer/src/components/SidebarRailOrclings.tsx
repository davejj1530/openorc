import { ContextMenu } from "@base-ui/react/context-menu";
import { threadStatus, NEEDS_YOU_PAGE, useSidebarNow } from "@openorc/client";
import { WORKSPACE_ID, type Orcling } from "@openorc/protocol";
import { CoversPreview } from "../lib/browser-preview";
import { useRpc } from "../lib/client";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import { useLayout } from "../lib/layout";
import { useOrclingChatIds, useOrclings } from "../lib/orclings";
import { useRouter } from "../lib/router";
import { useScrollEdges } from "../lib/use-scroll-edges";
import { floatingGround } from "../lib/use-anchor-ground";
import { markThread, workspaceMarks, workspaceSummary, type WorkspaceMark } from "../lib/workspace-rail";
import { Orclings } from "./icons";
import { menuItem, menuPopup } from "./menu";
import { OrclingAvatar } from "./OrclingAvatar";
import { ThreadStatusIndicator } from "./ThreadStatusIndicator";
import { RAIL_ICON } from "./sidebar-screens";
import { Tooltip } from "./ui";

/** What Orclings' chats, their own and their groups', have to say together: the most pressing one's mark, and how many of each. */
function useOrclingsMark(): WorkspaceMark | undefined {
  const homes = useOrclingChatIds();
  const now = useSidebarNow();
  const rows = useRpc(
    "threads.list",
    { projectIds: [WORKSPACE_ID], filter: "active", orderBy: "activity", includeChildren: false, needsYou: true, limit: NEEDS_YOU_PAGE },
    { enabled: homes.size > 0, refetchInterval: 60_000 },
  );
  return workspaceMarks(
    rows.data?.filter((thread) => homes.has(thread.id)),
    now,
  ).get(WORKSPACE_ID);
}

/** One Orcling on the rail: its face on a round tile, its conversation's mark in the corner, and a click opens the chat. */
function RailOrcling({ orcling, selected }: { orcling: Orcling; selected: boolean }) {
  const thread = useRpc("threads.get", { id: orcling.threadId }).data;
  const status = thread ? threadStatus(thread) : null;
  return (
    <li>
      <Tooltip
        side="right"
        label={
          <>
            <span className="block">{orcling.name}</span>
            {status ? <span className="block text-ink-3">{status.label}</span> : null}
          </>
        }
      >
        <button
          type="button"
          className="sidebar-dock-button sidebar-rail-project no-drag"
          aria-label={orcling.name}
          aria-description={status?.label}
          aria-current={selected || undefined}
          data-selected={selected || undefined}
          onClick={() => {
            useRouter.getState().navigate({ view: "thread", threadId: orcling.threadId });
            dismissCompactNavigation();
          }}
        >
          <OrclingAvatar orcling={orcling} size={26} />
          {thread && status ? (
            <span className="sidebar-rail-mark">
              <ThreadStatusIndicator thread={thread} />
            </span>
          ) : null}
        </button>
      </Tooltip>
    </li>
  );
}

/**
 * The rail's Orclings button, which switches the list beside it between project threads and Orclings. A right click
 * puts each Orcling's face under it, like the projects; while they are tucked away, the button carries the mark of
 * whichever Orcling most needs you.
 */
export function RailOrclings({ active, toggle, threadId }: { active: boolean; toggle: () => void; threadId: string | null }) {
  const orclings = useOrclings();
  const open = useLayout((s) => s.railOrclings) && orclings.length > 0;
  const mark = useOrclingsMark();
  const summary = workspaceSummary(mark);
  const edges = useScrollEdges();
  return (
    <>
      <ContextMenu.Root>
        <Tooltip
          side="right"
          label={
            <>
              <span className="block">Orclings</span>
              {summary && !open ? <span className="block text-ink-3">{summary}</span> : null}
            </>
          }
        >
          <ContextMenu.Trigger
            render={<button type="button" />}
            aria-label="Orclings"
            aria-description={(!open && summary) || undefined}
            aria-pressed={active}
            data-current={active || undefined}
            className="sidebar-dock-button sidebar-rail-orclings no-drag"
            onClick={() => {
              toggle();
              dismissCompactNavigation();
            }}
          >
            <Orclings size={RAIL_ICON} />
            {mark && !open ? (
              <span className="sidebar-rail-mark">
                <ThreadStatusIndicator thread={markThread(mark.kind)} />
              </span>
            ) : null}
          </ContextMenu.Trigger>
        </Tooltip>
        <ContextMenu.Portal>
          <CoversPreview />
          <ContextMenu.Positioner collisionPadding={8} className="z-40">
            <ContextMenu.Popup ref={floatingGround} className={menuPopup}>
              <ContextMenu.Item className={menuItem} disabled={!orclings.length} onClick={() => useLayout.getState().setRailOrclings(!open)}>
                {open ? "Hide Orclings from the rail" : "Show Orclings on the rail"}
              </ContextMenu.Item>
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {open ? (
        <div data-plane className="sidebar-rail-projects">
          <ul {...edges} className="sidebar-rail-projects-list scroll-edges" aria-label="Orclings">
            {orclings.map((orcling) => (
              <RailOrcling key={orcling.id} orcling={orcling} selected={threadId === orcling.threadId} />
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}
