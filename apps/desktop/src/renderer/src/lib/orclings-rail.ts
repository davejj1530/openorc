import { createContext, useEffect, useRef } from "react";
import type { Orcling } from "@openorc/protocol";
import { useRouter, type Route } from "./router";
import { useLayout } from "./layout";
import { useOrclingChatIds } from "./orclings";

/** A host supplies this destination when it provides an Orcling browser. */
export type OrclingsRailDestination = { active: boolean; open: () => void };
export const OrclingsRailContext = createContext<OrclingsRailDestination | null>(null);

/** Companion and project conversations occupy the same sidebar, remembering their own selection. */
export function useOrclingsRail(route: Route, orclings: readonly Orcling[]) {
  const chats = useOrclingChatIds();
  // An Orcling's own chat or a group chat of Orclings; either belongs to the Orclings side.
  const chat = route.view === "thread" && chats.has(route.threadId) ? route.threadId : null;
  const active = route.view === "orcling" || Boolean(chat);
  const lastOrcling = useRef<string | null>(null);
  const lastThread = useRef<string | null>(null);
  useEffect(() => {
    if (chat) lastOrcling.current = chat;
    else if (route.view === "thread") lastThread.current = route.threadId;
  }, [chat, route]);
  return {
    active,
    open: () => {
      const selected = lastOrcling.current && chats.has(lastOrcling.current) ? lastOrcling.current : orclings[0]?.threadId;
      useRouter.getState().navigate(selected ? { view: "thread", threadId: selected } : { view: "orcling" });
      useLayout.setState({ sidebarOpen: true });
    },
    openThreads: (fallback: () => void) => {
      if (lastThread.current && !chats.has(lastThread.current)) useRouter.getState().navigate({ view: "thread", threadId: lastThread.current });
      else fallback();
      useLayout.setState({ sidebarOpen: true });
    },
  };
}
