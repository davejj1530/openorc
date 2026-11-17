import type { TeamChatLease } from "@openorc/client";
import type { TeamChatTimeline } from "@openorc/protocol";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import type { ScrollViewInstance } from "react-native";
import { teamChat } from "../client";

/** A message to show in its conversation, as a search hit or a pin names it; `key` tells one request from the next. */
export interface ChatJump {
  id: string;
  seq: number;
  key: string;
}

/** A message asked to be shown in a conversation already open, as a pin asks, until the conversation has shown it. */
let asked: (ChatJump & { conversationId: string }) | null = null;
let asks = 0;
const listeners = new Set<() => void>();
const tell = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Asks the open conversation to show a message, paging back to it as a search hit does. */
export function showMessage(conversationId: string, message: { id: string; seq: number }): void {
  asked = { conversationId, id: message.id, seq: message.seq, key: `asked:${++asks}` };
  tell();
}

/** The message the open conversation is asked to show, for this conversation alone. */
export function useAskedJump(conversationId: string): ChatJump | null {
  const current = useSyncExternalStore(subscribe, () => asked);
  return current?.conversationId === conversationId ? current : null;
}

/**
 * Pages back, as the desktop does, until a message asked for is on the page, and then names it for the conversation to
 * scroll to. A message no longer there, or a page that fails, ends the request quietly.
 */
export function useMessageReveal(lease: TeamChatLease, conversationId: string, timeline: TeamChatTimeline | undefined, jump: ChatJump | null): ChatJump | null {
  const [failed, setFailed] = useState<string | null>(null);
  const paging = useRef(false);
  const messages = timeline?.messages ?? [];
  const found = Boolean(jump && messages.some((message) => message.id === jump.id));
  const oldest = messages[0]?.seq;
  const more = Boolean(jump && !found && failed !== jump.key && timeline?.older && oldest !== undefined && oldest > jump.seq);
  const key = jump?.key ?? null;
  useEffect(() => {
    if (!more || paging.current) return;
    paging.current = true;
    void teamChat
      .earlier(lease, conversationId)
      .catch(() => setFailed(key))
      .finally(() => {
        paging.current = false;
      });
  }, [more, oldest, lease, conversationId, key]);
  return found ? jump : null;
}

/**
 * Scrolls the conversation to the message being shown, once per request, wherever its row lays out: now, or later as
 * earlier pages arrive. Returns what each message row reports of where it sits.
 */
export function useRevealScroll(list: RefObject<ScrollViewInstance | null>, reveal: ChatJump | null, onReveal: () => void): (id: string, y: number) => void {
  const positions = useRef(new Map<string, number>());
  const shown = useRef<string | null>(null);
  const scroll = useCallback(
    (target: ChatJump, y: number) => {
      if (shown.current === target.key) return;
      shown.current = target.key;
      onReveal();
      list.current?.scrollTo({ y: Math.max(0, y - 96), animated: false });
      if (asked?.key === target.key) {
        asked = null;
        tell();
      }
    },
    [list, onReveal],
  );
  useEffect(() => {
    const y = reveal ? positions.current.get(reveal.id) : undefined;
    if (reveal && y !== undefined) scroll(reveal, y);
  }, [reveal, scroll]);
  return useCallback(
    (id: string, y: number) => {
      positions.current.set(id, y);
      if (reveal?.id === id) scroll(reveal, y);
    },
    [reveal, scroll],
  );
}
