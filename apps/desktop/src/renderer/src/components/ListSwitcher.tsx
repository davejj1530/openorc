import { useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { NEEDS_YOU_PAGE, threadStatus, waitsOnYou } from "@openorc/client";
import { WORKSPACE_ID } from "@openorc/protocol";
import { CoversPreview } from "../lib/browser-preview";
import { useRpc } from "../lib/client";
import { cn } from "../lib/cn";
import { useMentionSpaces } from "../lib/mention-spaces";
import { useOrclingChatIds } from "../lib/orclings";
import { useOrganization } from "../lib/organization-context";
import { PERSONAL_SPACE } from "../lib/space-name";
import { useSpaceNavigation } from "../lib/space-navigation";
import { useUnreadChatSpaces } from "../lib/team-chat-unread";
import { floatingGround } from "../lib/use-anchor-ground";
import { ChevronsUpDown } from "./icons";
import { InvitationIndicator } from "./InvitationIndicator";
import { OrganizationMark } from "./OrganizationMark";
import { SpaceMenu } from "./SpaceMenu";
import { menuPopup } from "./menu";
import "./list-switcher.css";

/** What holds the sidebar's list, a space's threads or the Orclings, and the ways between them. */
export interface ListChoice {
  orclings: boolean;
  showOrclings(): void;
  /** Leaves the Orclings for the threads. `stayed` says the space picked is the one already in view. */
  showThreads(stayed: boolean): void;
}

/** Orclings' chats, their own and their groups', that wait on the person. */
function useWaitingOrclings(): number {
  const homes = useOrclingChatIds();
  const rows = useRpc(
    "threads.list",
    { projectIds: [WORKSPACE_ID], filter: "active", orderBy: "activity", includeChildren: false, needsYou: true, limit: NEEDS_YOU_PAGE },
    { enabled: homes.size > 0, refetchInterval: 60_000 },
  );
  return (rows.data ?? []).filter((thread) => homes.has(thread.id) && waitsOnYou(threadStatus(thread))).length;
}

/**
 * The list's name, which switches what the list holds: the person's own workspaces, an organization's, or the
 * Orclings. It takes only the width its name needs. One neutral dot on its chevrons says something waits behind it.
 */
export function ListSwitcher({ list }: { list: ListChoice }) {
  const organizations = useOrganization();
  const actions = organizations?.signedIn ? organizations : null;
  const [open, setOpen] = useState(false);
  const status = actions?.status?.state === "ready" ? actions.status : null;
  const unread = useUnreadChatSpaces(status?.userId ?? null);
  const mentioned = useMentionSpaces(status?.userId ?? null);
  const current = useSpaceNavigation((state) => state.current);
  const waitingOrclings = useWaitingOrclings();
  const organization = list.orclings ? null : (actions?.organization ?? null);
  const label = list.orclings ? "Orclings" : (organization?.name ?? PERSONAL_SPACE);
  const invitations = status ? status.invitations.length : 0;
  const chats = (status?.spaces ?? []).flatMap((space) => (space.kind === "organization" && space.id !== current && unread.includes(space.id) ? [space.name] : []));
  const mentions = (status?.spaces ?? []).flatMap((space) => (space.kind === "organization" && mentioned.includes(space.id) ? [space.name] : []));
  const orclings = list.orclings ? 0 : waitingOrclings;
  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger className="list-switcher no-drag" aria-label={switchLabel(label, { invitations, chats, mentions, orclings })}>
        {organization ? <OrganizationMark {...organization} size={16} /> : null}
        <span className="list-switcher-name" data-tip={label}>
          {label}
        </span>
        <InvitationIndicator count={invitations} chats={chats} mentions={mentions} orclings={orclings}>
          <ChevronsUpDown size={10} className="list-switcher-chevron" />
        </InvitationIndicator>
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner align="start" alignOffset={-3} sideOffset={3} collisionPadding={8} className="z-40">
          <Menu.Popup ref={floatingGround} className={cn(menuPopup, "space-menu")}>
            <SpaceMenu actions={actions} list={list} waitingOrclings={orclings} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** The switcher's spoken name: what the list holds, then what waits, as its dot says on demand. */
function switchLabel(label: string, waits: { invitations: number; chats: readonly string[]; mentions: readonly string[]; orclings: number }): string {
  const waiting = [
    waits.invitations ? `${waits.invitations} invitation${waits.invitations === 1 ? "" : "s"}` : "",
    waits.chats.length ? `unread chat in ${waits.chats.join(", ")}` : "",
    waits.mentions.length ? `unread mention in ${waits.mentions.join(", ")}` : "",
    waits.orclings ? `${waits.orclings} Orcling${waits.orclings === 1 ? "" : "s"} waiting` : "",
  ].filter(Boolean);
  return [`Switch list, ${label}`, ...waiting].join(", ");
}
