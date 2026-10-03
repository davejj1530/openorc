import { createContext, useEffect, useRef } from "react";
import type { Orcling } from "@openorc/protocol";
import { useRouter, type Route } from "./router";
import { useLayout } from "./layout";
import { orclingHome } from "./orclings";

/** A host supplies this destination when it provides an Orcling browser. */
export type OrclingsRailDestination = { active: boolean; open: () => void };
export const OrclingsRailContext = createContext<OrclingsRailDestination | null>(null);

/** Companion and project conversations occupy the same sidebar, remembering their own selection. */
export function useOrclingsRail(route: Route, orclings: readonly Orcling[]) {
  const home = orclingHome(orclings, route.view === "thread" ? route.threadId : null);
  const active = route.view === "orcling" || Boolean(home);
  const lastOrcling = useRef<string | null>(null);
  const lastThread = useRef<string | null>(null);
  useEffect(() => {
    if (home) lastOrcling.current = home.threadId;
    else if (route.view === "thread") lastThread.current = route.threadId;
  }, [home, route]);
  return {
    active,
    open: () => {
      const selected = orclings.find((item) => item.threadId === lastOrcling.current) ?? orclings[0];
      useRouter.getState().navigate(selected ? { view: "thread", threadId: selected.threadId } : { view: "orcling" });
      useLayout.setState({ sidebarOpen: true });
    },
    openThreads: (fallback: () => void) => {
      if (lastThread.current && !orclings.some((item) => item.threadId === lastThread.current)) useRouter.getState().navigate({ view: "thread", threadId: lastThread.current });
      else fallback();
      useLayout.setState({ sidebarOpen: true });
    },
  };
}
