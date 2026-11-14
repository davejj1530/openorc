import { createContext, useContext } from "react";
import type { TeamChatScope } from "@openorc/client";

/** An authorized, window-scoped lease supplied by the shared organization gate. */
export interface TeamChatContextValue extends TeamChatScope {
  generation: number;
  reach: "live" | "offline";
  current(): boolean;
}
export const TeamChatContext = createContext<TeamChatContextValue | null>(null);
export const useTeamChatContext = () => useContext(TeamChatContext);
