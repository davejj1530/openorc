import { createContext, useContext } from "react";

export const TeamChatVisibility = createContext(true);
export const useTeamChatVisible = () => useContext(TeamChatVisibility);
