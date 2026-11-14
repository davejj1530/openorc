import { useEffect, useRef, useState } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import type { TeamChatPerson, TeamChatReaction, TeamMessage } from "@openorc/protocol";
import { cn } from "../lib/cn";
import { useTeamChatVisible } from "../lib/team-chat-visibility";
import { CoversPreview } from "../lib/browser-preview";
import { floatingGround } from "../lib/use-anchor-ground";
import { Copy, SmilePlus } from "./icons";
import { menuItem, menuPopup } from "./menu";
import { TeamChatReactionPicker, TeamChatReactions } from "./TeamChatReactions";
import { ThreadRichText } from "./ThreadImages";
import { Tooltip } from "./ui";

export function TeamChatMessage({
  message,
  self,
  people,
  reason,
  onReact,
}: {
  message: TeamMessage;
  self: string;
  people: readonly TeamChatPerson[];
  reason: string | null;
  onReact(emoji: TeamChatReaction): void;
}) {
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const visible = useTeamChatVisible();
  const [copyError, setCopyError] = useState(false);
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!visible) {
      setOpen(false);
      setMenuOpen(false);
    }
  }, [visible]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !row.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const mine = message.actor.person?.id === self;
  const copy = () => {
    void navigator.clipboard.writeText(message.body).then(
      () => setCopyError(false),
      () => setCopyError(true),
    );
  };
  return (
    <div ref={row} className={cn("orcling-bubble-row team-chat-message", mine && "team-chat-message-mine")} data-open={(open && !reason) || undefined} data-message-id={message.id}>
      <ContextMenu.Root open={menuOpen && visible} onOpenChange={setMenuOpen}>
        <ContextMenu.Trigger className={cn("orcling-bubble", mine && "message-bubble")} tabIndex={0} aria-label={`${message.actor.person?.name ?? "Former member"}: ${message.body}`}>
          <div className="text-prose text-ink prose-chat">
            <ThreadRichText mode="static">{message.body}</ThreadRichText>
          </div>
          <TeamChatReactions reactions={message.reactions} people={people} self={self} onReact={onReact} reason={reason} side={mine ? "start" : "end"} />
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <CoversPreview />
          <ContextMenu.Positioner collisionPadding={8} className="z-40">
            <ContextMenu.Popup ref={floatingGround} className={menuPopup}>
              <ContextMenu.Item className={menuItem} onClick={copy}>
                <Copy size={14} />
                Copy text
              </ContextMenu.Item>
              <Tooltip label={reason ?? "React"}>
                <ContextMenu.Item className={menuItem} disabled={Boolean(reason)} onClick={() => setOpen(true)}>
                  <SmilePlus size={14} />
                  React
                </ContextMenu.Item>
              </Tooltip>
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      <Tooltip label={reason ?? "React"}>
        <button type="button" className="orcling-react-open" aria-label="React" aria-expanded={open} disabled={Boolean(reason)} onClick={() => setOpen(!open)}>
          <SmilePlus size={16} />
        </button>
      </Tooltip>
      <TeamChatReactionPicker open={open && !reason} reactions={message.reactions} self={self} onReact={onReact} onClose={() => setOpen(false)} />
      {copyError ? (
        <span role="status" className="team-chat-message-error">
          Text could not be copied.
        </span>
      ) : null}
    </div>
  );
}
