import { useCallback, useEffect, useRef, useState } from "react";
import type { TeamConversation, TeamMessage } from "@openorc/protocol";
import { teamChat } from "./team-chat-queries";
import type { TeamChatContextValue } from "./team-chat-context";
import type { TeamChatTarget } from "@openorc/client";

/** Whether the person can be looking at this window: it is focused and its page is visible. */
export function useWindowAttention(): boolean {
  const read = () => typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();
  const [attending, setAttending] = useState(read);
  useEffect(() => {
    const update = () => setAttending(read());
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return attending;
}

/**
 * The latest message whose trailing edge is inside the viewport: a tall bubble counts once its end is shown, and a
 * message below the fold never does, however near.
 */
export function lastDisplayed<T extends { id: string; seq: number }>(messages: readonly T[], viewport: { top: number; bottom: number }, edgeOf: (id: string) => number | null): T | null {
  let latest: T | null = null;
  for (const message of messages) {
    const bottom = edgeOf(message.id);
    if (bottom === null || bottom > viewport.bottom + 1 || bottom < viewport.top) continue;
    if (!latest || message.seq > latest.seq) latest = message;
  }
  return latest;
}

/** Where a conversation's later messages begin for this opening: the place it had when it opened, never moved after. */
export function useNewFrom(conversation: TeamConversation, unread: boolean): number | null {
  const [from] = useState(() => (unread && conversation.joined && conversation.read && conversation.read.unread > 0 ? conversation.read.seenSeq : null));
  return from;
}

/**
 * Sends the place forward to what this window showed, a moment after it settles. Never behind what the server already
 * holds, never for a message that was not displayed, and a refused write leaves the count as it was.
 */
export function useTeamChatSeen(scope: TeamChatContextValue, target: TeamChatTarget, conversation: TeamConversation, enabled: boolean) {
  const known = conversation.read?.seenSeq ?? 0;
  const sent = useRef(known);
  const waiting = useRef<{ id: string; seq: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useRef(() => {});
  flush.current = () => {
    const next = waiting.current;
    waiting.current = null;
    if (!next || !scope.current() || next.seq <= sent.current) return;
    const before = sent.current;
    sent.current = next.seq;
    void teamChat.seen(scope, target, next).catch(() => {
      if (sent.current === next.seq) sent.current = before;
    });
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      flush.current();
    },
    [],
  );
  const allowed = useRef({ enabled, joined: conversation.joined, known });
  allowed.current = { enabled, joined: conversation.joined, known };
  // One callback for the conversation's life, so the transcript measures once per change rather than once per render.
  return useCallback((message: Pick<TeamMessage, "id" | "seq">) => {
    const now = allowed.current;
    if (!now.enabled || !now.joined || message.seq <= Math.max(sent.current, now.known)) return;
    if (waiting.current && waiting.current.seq >= message.seq) return;
    waiting.current = { id: message.id, seq: message.seq };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => flush.current(), 250);
  }, []);
}
