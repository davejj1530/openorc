import { useState, type ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { Space } from "@openorc/protocol";
import type { OrganizationActions } from "../lib/organization-context";
import { useOrclings } from "../lib/orclings";
import { spaceName } from "../lib/space-name";
import { useSpaceNavigation } from "../lib/space-navigation";
import { floatingGround } from "../lib/use-anchor-ground";
import { cn } from "../lib/cn";
import { OpenOrcMark } from "./OpenOrcMark";
import { OrganizationMark } from "./OrganizationMark";
import { Check, Orclings, People, PersonPlus, Plus } from "./icons";
import type { ListChoice } from "./ListSwitcher";
import { menuItem, menuSeparator } from "./menu";
import { ReceivedInvitationRow } from "./ReceivedInvitationRow";
import { TextButton, Tooltip } from "./ui";
import { useUnreadChatSpaces } from "../lib/team-chat-unread";
import { useMentionSpaces } from "../lib/mention-spaces";

/**
 * What the list can hold: each organization, the person's own workspaces, then the Orclings, with the one that holds it
 * ticked. Signed in, an organization's own actions and a way to create one follow.
 */
export function SpaceMenu({ actions, list, waitingOrclings }: { actions: OrganizationActions | null; list: ListChoice; waitingOrclings: number }) {
  const current = useSpaceNavigation((state) => state.current);
  const data = actions?.status?.state === "ready" ? actions.status : null;
  const shown = current ?? data?.personalSpaceId;
  const pick = (id: string | undefined) => {
    const stayed = id === shown;
    if (id && !stayed) actions?.select(id);
    if (list.orclings) list.showThreads(stayed);
  };
  const spaces = data ? [...data.spaces.filter((space) => space.kind === "organization"), ...data.spaces.filter((space) => space.kind === "personal")] : [];
  const unread = useUnreadChatSpaces(data?.userId ?? null);
  const mentioned = useMentionSpaces(data?.userId ?? null);
  return (
    <>
      {spaces.map((space) => (
        <SpaceRow
          key={space.id}
          space={space}
          person={actions?.person ?? ""}
          checked={!list.orclings && space.id === shown}
          unread={space.id !== current && unread.includes(space.id)}
          mentioned={mentioned.includes(space.id)}
          onClick={() => pick(space.id)}
        />
      ))}
      {!data ? <SpaceRow space={{ id: "", kind: "personal" }} person={actions?.person ?? ""} checked={!list.orclings} onClick={() => pick(shown)} /> : null}
      {actions && !data ? <SpaceReadState actions={actions} /> : null}
      {actions && data?.invitations.length ? <Menu.Separator className={menuSeparator} /> : null}
      {actions ? data?.invitations.map((invitation) => <ReceivedInvitationRow key={invitation.id} invitation={invitation} actions={actions.invitations} />) : null}
      <Menu.Separator className={menuSeparator} />
      <OrclingsRow checked={list.orclings} waiting={waitingOrclings} onClick={list.showOrclings} />
      {actions ? <SpaceActions actions={actions} create={data?.create} /> : null}
    </>
  );
}

/** The Orclings as a thing the list can hold: who they are, and how many of their chats wait on the person. */
function OrclingsRow({ checked, waiting, onClick }: { checked: boolean; waiting: number; onClick(): void }) {
  const names = useOrclings()
    .map((orcling) => orcling.name)
    .join(", ");
  return (
    <Menu.Item className={cn(menuItem, "space-menu-row")} role="menuitemradio" aria-checked={checked} onClick={onClick}>
      <span className="space-menu-mark">
        <Orclings size={20} />
      </span>
      <span className="space-menu-label">
        <span>Orclings</span>
        {names ? <span className="space-menu-detail">{names}</span> : null}
      </span>
      {waiting ? <span className="sidebar-count tabular">{waiting > 99 ? "99+" : waiting}</span> : null}
      {checked ? <Check size={14} /> : null}
    </Menu.Item>
  );
}

/** What a signed-in person does with organizations from here: the open one's people, and creating another. */
function SpaceActions({ actions, create }: { actions: OrganizationActions; create: { allowed: boolean; reason: string | null } | undefined }) {
  return (
    <>
      {actions.organization ? (
        <>
          <Menu.Separator className={menuSeparator} />
          <Menu.Item className={menuItem} onClick={() => actions.people()}>
            <span className="space-menu-mark">
              <People size={18} />
            </span>
            People
          </Menu.Item>
          {actions.organization.role === "admin" ? (
            <Menu.Item className={menuItem} onClick={actions.invite}>
              <span className="space-menu-mark">
                <PersonPlus size={18} />
              </span>
              Invite people…
            </Menu.Item>
          ) : null}
        </>
      ) : null}
      <Menu.Separator className={menuSeparator} />
      <CreateAction allowed={Boolean(create?.allowed)} reason={create?.reason ?? actions.error ?? "Loading spaces…"} run={actions.create} />
    </>
  );
}

/** The space's mark with the one neutral dot an unread mention there puts on it, its words on demand. */
function MentionedMark({ children }: { children: ReactNode }) {
  return (
    <Tooltip label="Unread mention">
      <span className="organization-invitation-mark">
        {children}
        <span className="organization-invitation-dot" role="img" aria-label="Unread mention" />
      </span>
    </Tooltip>
  );
}

function SpaceRow({ space, person, checked, unread = false, mentioned = false, onClick }: { space: Space; person: string; checked: boolean; unread?: boolean; mentioned?: boolean; onClick(): void }) {
  const label = spaceName(space);
  const mark = space.kind === "personal" ? <OpenOrcMark size={24} /> : <OrganizationMark {...space} size={24} />;
  const detail = space.kind === "personal" ? person : `${space.memberCount} ${space.memberCount === 1 ? "person" : "people"}`;
  return (
    <Menu.Item className={cn(menuItem, "space-menu-row")} role="menuitemradio" aria-checked={checked} onClick={onClick}>
      <span className="space-menu-mark">{mentioned ? <MentionedMark>{mark}</MentionedMark> : mark}</span>
      <span className="space-menu-label">
        <span data-tip={label}>{label}</span>
        {detail ? <span className="space-menu-detail">{detail}</span> : null}
      </span>
      {unread ? (
        <Tooltip label="Unread chat">
          <span className="space-menu-unread" role="img" aria-label="Unread chat" />
        </Tooltip>
      ) : null}
      {checked ? <Check size={14} /> : null}
    </Menu.Item>
  );
}

function CreateAction({ allowed, reason, run }: { allowed: boolean; reason: string; run(): void }) {
  const content = (
    <>
      <span className="space-menu-mark">
        <Plus size={18} />
      </span>
      Create organization…
    </>
  );
  if (allowed)
    return (
      <Menu.Item className={menuItem} onClick={run}>
        {content}
      </Menu.Item>
    );
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={<Menu.Item className={menuItem} disabled />}>{content}</BaseTooltip.Trigger>
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner sideOffset={6} className="z-50">
          <BaseTooltip.Popup ref={floatingGround} className="tooltip-popup">
            {reason}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}

function SpaceReadState({ actions }: { actions: OrganizationActions }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retry = async () => {
    if (pending) return;
    setPending(true);
    try {
      await actions.refresh();
      setError(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : "OpenOrc Cloud can't be reached.");
    } finally {
      setPending(false);
    }
  };
  const message = error ?? actions.error;
  return (
    <div className="space-menu-read">
      <span>{message ?? "Loading spaces…"}</span>
      {message ? (
        <TextButton disabled={pending} onClick={() => void retry()}>
          {pending ? "Trying…" : "Try again"}
        </TextButton>
      ) : null}
    </div>
  );
}
