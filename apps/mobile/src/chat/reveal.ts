import type { TeamChatLease } from "@openorc/client";
import type { TeamChatTimeline } from "@openorc/protocol";
import { useEffect, useRef, useState } from "react";
import { teamChat } from "../client";

/** A message to show in its conversation, as a search hit names it. */
export interface ChatJump {
  id: string;
  seq: number;
}

/**
 * Pages back, as the desktop does, until a message asked for is on the page, and then names it for the conversation to
 * scroll to. A message no longer there, or a page that fails, ends the request quietly.
 */
export function useMessageReveal(lease: TeamChatLease, conversationId: string, timeline: TeamChatTimeline | undefined, jump: ChatJump | null): string | null {
  const [failed, setFailed] = useState(false);
  const paging = useRef(false);
  const messages = timeline?.messages ?? [];
  const found = Boolean(jump && messages.some((message) => message.id === jump.id));
  const oldest = messages[0]?.seq;
  const more = Boolean(jump && !found && !failed && timeline?.older && oldest !== undefined && oldest > jump.seq);
  useEffect(() => {
    if (!more || paging.current) return;
    paging.current = true;
    void teamChat
      .earlier(lease, conversationId)
      .catch(() => setFailed(true))
      .finally(() => {
        paging.current = false;
      });
  }, [more, oldest, lease, conversationId]);
  return found && jump ? jump.id : null;
}
