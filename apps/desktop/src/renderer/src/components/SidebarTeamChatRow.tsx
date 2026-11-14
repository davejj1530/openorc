import { ContextMenu } from "@base-ui/react/context-menu";
import type { TeamChatRow } from "@openorc/client";
import type { TeamConversation } from "@openorc/protocol";
import { cn } from "../lib/cn";
import { CoversPreview } from "../lib/browser-preview";
import { floatingGround } from "../lib/use-anchor-ground";
import { TeamChatFace, TeamConversationFace } from "./TeamChatFace";
import { X } from "./icons";
import { menuItem, menuPopup } from "./menu";

export function SidebarTeamChatRow({
  row,
  self,
  selected,
  pending,
  onOpen,
  onCloseGroup,
}: {
  row: TeamChatRow;
  self: string;
  selected: string | null;
  pending: boolean;
  onOpen(row: TeamChatRow): void;
  onCloseGroup?: (conversation: TeamConversation) => void;
}) {
  const conversation = row.conversation;
  const current = conversation?.id === selected;
  const button = (
    <button
      type="button"
      className={cn("sidebar-chat-row", current && "sidebar-chat-row-current")}
      aria-current={current ? "page" : undefined}
      aria-busy={pending || undefined}
      onClick={() => onOpen(row)}
    >
      {row.kind === "person" ? <TeamChatFace people={[row.person]} /> : <TeamConversationFace conversation={row.conversation} self={self} />}
      <span className="sidebar-chat-title" data-tip={row.title}>
        {row.title}
      </span>
    </button>
  );
  if (row.kind === "person" || conversation?.kind !== "dm" || (conversation.participants?.length ?? 0) < 3 || !onCloseGroup) return button;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        render={button}
        onKeyDown={(event) => {
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          const { left, bottom } = event.currentTarget.getBoundingClientRect();
          event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: left, clientY: bottom }));
        }}
      />
      <ContextMenu.Portal>
        <CoversPreview />
        <ContextMenu.Positioner collisionPadding={8} className="z-40">
          <ContextMenu.Popup ref={floatingGround} className={menuPopup}>
            <ContextMenu.Item className={menuItem} onClick={() => onCloseGroup(conversation)}>
              <X size={14} />
              Close chat
            </ContextMenu.Item>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
