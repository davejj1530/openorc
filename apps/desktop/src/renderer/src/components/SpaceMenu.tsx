import { useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { Space } from "@openorc/protocol";
import type { OrganizationActions } from "../lib/organization-context";
import { useSpaceNavigation } from "../lib/space-navigation";
import { floatingGround } from "../lib/use-anchor-ground";
import { cn } from "../lib/cn";
import { OpenOrcMark } from "./OpenOrcMark";
import { OrganizationMark } from "./OrganizationMark";
import { Check, People, PersonPlus, Plus } from "./icons";
import { menuItem, menuSeparator } from "./menu";
import { ReceivedInvitationRow } from "./ReceivedInvitationRow";
import { TextButton, Tooltip } from "./ui";
import { useUnreadChatSpaces } from "../lib/team-chat-unread";

export function SpaceMenu({ actions }: { actions: OrganizationActions }) {
  const current = useSpaceNavigation((state) => state.current);
  const data = actions.status?.state === "ready" ? actions.status : null;
  const spaces = data ? [...data.spaces.filter((space) => space.kind === "organization"), ...data.spaces.filter((space) => space.kind === "personal")] : [];
  const unread = useUnreadChatSpaces(data?.userId ?? null);
  return (
    <>
      {spaces.map((space) => (
        <SpaceRow
          key={space.id}
          space={space}
          person={actions.person}
          checked={space.id === (current ?? data?.personalSpaceId)}
          unread={space.id !== current && unread.includes(space.id)}
          onClick={() => actions.select(space.id)}
        />
      ))}
      {!data ? <SpaceRow space={{ id: "", kind: "personal" }} person={actions.person} checked onClick={() => {}} /> : null}
      {!data ? <SpaceReadState actions={actions} /> : null}
      {data?.invitations.length ? <Menu.Separator className={menuSeparator} /> : null}
      {data?.invitations.map((invitation) => (
        <ReceivedInvitationRow key={invitation.id} invitation={invitation} actions={actions.invitations} />
      ))}
      {actions.organization ? (
        <>
          <Menu.Separator className={menuSeparator} />
          <Menu.Item className={menuItem} onClick={() => actions.people()}>
            <span className="space-menu-mark">
              <People size={15} />
            </span>
            People
          </Menu.Item>
          {actions.organization.role === "admin" ? (
            <Menu.Item className={menuItem} onClick={actions.invite}>
              <span className="space-menu-mark">
                <PersonPlus size={15} />
              </span>
              Invite people…
            </Menu.Item>
          ) : null}
        </>
      ) : null}
      <Menu.Separator className={menuSeparator} />
      <CreateAction allowed={Boolean(data?.create.allowed)} reason={data?.create.reason ?? actions.error ?? "Loading spaces…"} run={actions.create} />
    </>
  );
}

function SpaceRow({ space, person, checked, unread = false, onClick }: { space: Space; person: string; checked: boolean; unread?: boolean; onClick(): void }) {
  const label = space.kind === "personal" ? "Personal" : space.name;
  return (
    <Menu.Item className={cn(menuItem, "space-menu-row")} role="menuitemradio" aria-checked={checked} onClick={onClick}>
      <span className="space-menu-mark">{space.kind === "personal" ? <OpenOrcMark size={24} /> : <OrganizationMark {...space} size={24} />}</span>
      <span className="space-menu-label">
        <span data-tip={label}>{label}</span>
        <span className="space-menu-detail">{space.kind === "personal" ? person : `${space.memberCount} ${space.memberCount === 1 ? "person" : "people"}`}</span>
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
        <Plus size={15} />
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
