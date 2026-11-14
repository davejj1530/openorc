import { useState, type ReactNode } from "react";
import type { TeamChatRow } from "@openorc/client";
import type { TeamConversation } from "@openorc/protocol";
import { useTeamChatOrder } from "../lib/use-team-chat-order";
import { SidebarListHead } from "./SidebarListHead";
import { SidebarTeamChatRow, TeamChatMarks } from "./SidebarTeamChatRow";
import "../styles/team-chat-unread.css";
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
  onCloseGroup?: (conversation: TeamConversation) => void;
  unread?: boolean;
}
export function SidebarChat({ rows, self, selected, opening, error, onOpen, onRetry, tools, onCloseGroup, unread = false }: SidebarChatProps) {
  const [open, setOpen] = useState(true);
  const order = useTeamChatOrder(rows);
  const total = unread ? rows.reduce((sum, row) => sum + (row.conversation?.read?.unread ?? 0), 0) : 0;
  const mention = unread && rows.some((row) => row.conversation?.read?.hasMention);
  return (
    <section className="sidebar-chat" aria-label="Chat" {...order.props}>
      <SidebarListHead
        label="Chat"
        fold={{
          open,
          waiting: 0,
          onToggle: () => setOpen(!open),
          folded: total > 0 ? { marks: <TeamChatMarks count={total} mention={mention} />, words: `${total} unread${mention ? ", mentions you" : ""}` } : undefined,
        }}
        tools={tools}
      />
      {open ? (
        <div className="sidebar-chat-list">
          {order.rows.map((row) => (
            <SidebarTeamChatRow key={`${row.kind}:${row.id}`} row={row} self={self} selected={selected} pending={opening === row.id} onOpen={onOpen} onCloseGroup={onCloseGroup} unread={unread} />
          ))}
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
