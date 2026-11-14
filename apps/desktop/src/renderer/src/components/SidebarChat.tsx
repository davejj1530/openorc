import { useState, type ReactNode } from "react";
import type { TeamChatRow } from "@openorc/client";
import { cn } from "../lib/cn";
import { useTeamChatOrder } from "../lib/use-team-chat-order";
import { SidebarListHead } from "./SidebarListHead";
import { TeamChatFace, TeamConversationFace } from "./TeamChatFace";
import { Tooltip } from "./ui";
import "../styles/team-chat.css";

export interface SidebarChatProps {
  rows: readonly TeamChatRow[];
  self: string;
  selected: string | null;
  opening: string | null;
  error: string | null;
  onOpen(row: TeamChatRow): void;
  onRetry(): void;
  tools?: ReactNode;
}
export function SidebarChat({ rows, self, selected, opening, error, onOpen, onRetry, tools }: SidebarChatProps) {
  const [open, setOpen] = useState(true);
  const order = useTeamChatOrder(rows);
  return (
    <section className="sidebar-chat" aria-label="Chat" {...order.props}>
      <SidebarListHead label="Chat" fold={{ open, waiting: 0, onToggle: () => setOpen(!open) }} tools={tools} />
      {open ? (
        <div className="sidebar-chat-list">
          {order.rows.map((row) => {
            const conversationId = row.kind === "person" ? row.conversation?.id : row.conversation.id;
            const pending = opening === row.id;
            return (
              <button
                key={`${row.kind}:${row.id}`}
                type="button"
                className={cn("sidebar-chat-row", conversationId === selected && "sidebar-chat-row-current")}
                aria-current={conversationId === selected ? "page" : undefined}
                aria-busy={pending || undefined}
                onClick={() => onOpen(row)}
              >
                {row.kind === "person" ? <TeamChatFace people={[row.person]} /> : <TeamConversationFace conversation={row.conversation} self={self} />}
                <span className="sidebar-chat-title" data-tip={row.title}>
                  {row.title}
                </span>
              </button>
            );
          })}
          {error ? (
            <div className="sidebar-chat-error">
              <Tooltip label={error}>
                <button type="button" onClick={onRetry}>
                  Try again
                </button>
              </Tooltip>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
