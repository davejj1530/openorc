import { useEffect, useRef } from "react";
import { TeamChatReaction, type TeamChatPerson, type TeamMessage } from "@openorc/protocol";
import { Tooltip } from "./ui";

export function TeamChatReactions({
  reactions,
  people,
  self,
  onReact,
  reason,
  side,
}: {
  reactions: TeamMessage["reactions"];
  people: readonly TeamChatPerson[];
  self: string;
  onReact(emoji: TeamChatReaction): void;
  reason: string | null;
  side: "start" | "end";
}) {
  if (!reactions.length) return null;
  return (
    <div className="orcling-reaction" data-side={side}>
      {reactions.map(({ emoji, userIds }) => {
        const reaction = TeamChatReaction.safeParse(emoji);
        const names = userIds.map((id) => (id === self ? "You" : (people.find((person) => person.id === id)?.name ?? "Former member"))).join(", ");
        return (
          <Tooltip key={emoji} label={reason ?? `${names} ${emoji}`}>
            <button
              type="button"
              disabled={Boolean(reason) || !reaction.success}
              aria-pressed={userIds.includes(self)}
              data-current={userIds.includes(self) || undefined}
              aria-label={`${emoji}, ${userIds.length} reactions`}
              onClick={() => {
                if (reaction.success) onReact(reaction.data);
              }}
            >
              {emoji}
              {userIds.length > 1 ? <span>{userIds.length}</span> : null}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

export function TeamChatReactionPicker({
  open,
  reactions,
  self,
  onReact,
  onClose,
}: {
  open: boolean;
  reactions: TeamMessage["reactions"];
  self: string;
  onReact(emoji: TeamChatReaction): void;
  onClose(): void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) bar.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [open]);
  return (
    <div
      ref={bar}
      className="orcling-react-bar"
      role="toolbar"
      aria-label="Reactions"
      inert={!open}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      {TeamChatReaction.options.map((emoji) => (
        <button
          key={emoji}
          type="button"
          className="orcling-react-choice"
          aria-label={emoji}
          aria-pressed={reactions.some((reaction) => reaction.emoji === emoji && reaction.userIds.includes(self))}
          data-current={reactions.some((reaction) => reaction.emoji === emoji && reaction.userIds.includes(self)) || undefined}
          onClick={() => {
            onReact(emoji);
            onClose();
          }}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}
