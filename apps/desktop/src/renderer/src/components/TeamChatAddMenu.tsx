import { useState } from "react";
import { Menu } from "@base-ui/react/menu";
import type { TeamChatState } from "@openorc/protocol";
import type { TeamChatContextValue } from "../lib/team-chat-context";
import { useOrganization } from "../lib/organization-context";
import { CoversPreview } from "../lib/browser-preview";
import { floatingGround } from "../lib/use-anchor-ground";
import { Hash, MessageSquare, Plus, Search } from "./icons";
import { IconButton } from "./ui";
import { menuItem, menuPopup } from "./menu";
import { TeamChannelDialog } from "./TeamChannelDialog";
import { TeamChannelBrowser } from "./TeamChannelBrowser";
import { TeamGroupDialog } from "./TeamGroupDialog";

export function TeamChatAddMenu({ scope, chat }: { scope: TeamChatContextValue; chat: TeamChatState }) {
  const [dialog, setDialog] = useState<"new" | "browse" | "group" | null>(null);
  const actions = useOrganization();
  const organization = actions?.organization;
  return (
    <>
      <Menu.Root>
        <Menu.Trigger render={<IconButton aria-label="Add conversation" size="xs" className="no-drag" />}>
          <Plus size={16} />
        </Menu.Trigger>
        <Menu.Portal>
          <CoversPreview />
          <Menu.Positioner side="top" sideOffset={6} align="end" className="z-40" collisionPadding={8}>
            <Menu.Popup className={menuPopup} ref={floatingGround}>
              {chat.features.includes("groups") ? (
                <Menu.Item className={menuItem} onClick={() => setDialog("group")}>
                  <MessageSquare size={16} />
                  New group chat…
                </Menu.Item>
              ) : null}
              <Menu.Item className={menuItem} onClick={() => setDialog("new")}>
                <Hash size={16} />
                New channel…
              </Menu.Item>
              <Menu.Item className={menuItem} onClick={() => setDialog("browse")}>
                <Search size={16} />
                Browse channels…
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {dialog === "new" ? <TeamChannelDialog scope={scope} organizationName={organization?.name ?? "this organization"} people={chat.people} onClose={() => setDialog(null)} /> : null}
      {dialog === "browse" ? <TeamChannelBrowser conversations={chat.conversations} self={scope.accountId} onClose={() => setDialog(null)} /> : null}
      {dialog === "group" && chat.features.includes("groups") ? (
        <TeamGroupDialog
          scope={scope}
          people={chat.people}
          onClose={() => setDialog(null)}
          {...(organization?.role === "admin" &&
            actions && {
              onInvite: () => {
                setDialog(null);
                actions.invite();
              },
            })}
        />
      ) : null}
    </>
  );
}
