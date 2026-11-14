import { useRef, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import type { OrganizationPerson } from "@openorc/protocol";
import { useTeamChatContext } from "../lib/team-chat-context";
import { useTeamChatState } from "../lib/team-chat-queries";
import { useOpenTeamChat } from "../lib/team-chat-open";
import { CoversPreview } from "../lib/browser-preview";
import { floatingGround } from "../lib/use-anchor-ground";
import { cn } from "../lib/cn";
import { IconButton } from "./ui";
import { MoreHorizontal, MessageSquare, X } from "./icons";
import { menuItem, menuItemDanger, menuPopup } from "./menu";

export interface TeamChatPersonMenuProps {
  person: OrganizationPerson;
  spaceId: string;
  editable: boolean;
  onRemove(person: OrganizationPerson, trigger: HTMLButtonElement | null): void;
}

export function TeamChatPersonMenu({ person, spaceId, editable, onRemove }: TeamChatPersonMenuProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const scope = useTeamChatContext();
  const state = useTeamChatState();
  const action = useOpenTeamChat();
  const peer =
    scope?.spaceId === spaceId && scope.accountId !== person.userId && state.data?.state === "ready" && state.data.chat.features.includes("base")
      ? state.data.chat.people.find((candidate) => candidate.id === person.userId)
      : undefined;
  if (!editable && !peer) return null;
  const offline = scope?.reach === "offline";
  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger ref={trigger} render={<IconButton aria-label={`More for ${person.name}`} size="xs" />}>
        <MoreHorizontal size={15} />
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner align="end" sideOffset={4} collisionPadding={8} className="z-40">
          <Menu.Popup ref={floatingGround} className={cn(menuPopup, "people-member-menu")}>
            {peer ? (
              <Menu.Item
                className={menuItem}
                closeOnClick={false}
                disabled={Boolean(action.opening) || offline}
                data-tip={offline ? "Reconnect to open chat" : undefined}
                onClick={() => {
                  void action.open({ kind: "person", id: peer.id, title: peer.name, person: peer, conversation: null }).then((opened) => {
                    if (opened) setOpen(false);
                  });
                }}
              >
                <MessageSquare size={14} />
                Message
              </Menu.Item>
            ) : null}
            {editable ? (
              <Menu.Item className={menuItemDanger} onClick={() => onRemove(person, trigger.current)}>
                <X size={14} />
                Remove member…
              </Menu.Item>
            ) : null}
            {action.error ? (
              <p role="alert" className="max-w-64 px-3 py-2 text-sm text-bad">
                {action.error}
              </p>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
