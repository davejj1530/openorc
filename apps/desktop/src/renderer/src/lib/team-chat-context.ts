import { createContext, useContext } from "react";
import type { TeamChatLease } from "@openorc/client";

/** An authorized, window-scoped lease supplied by the shared organization gate. */
export type TeamChatContextValue = TeamChatLease;
export const TeamChatContext = createContext<TeamChatContextValue | null>(null);
export const useTeamChatContext = () => useContext(TeamChatContext);
