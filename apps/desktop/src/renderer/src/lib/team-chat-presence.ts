import type { TeamChatPresence } from "@openorc/protocol";
import { useTeamChatContext } from "./team-chat-context";
import { teamChat, useTeamChatState } from "./team-chat-queries";

/** Who of the organization this window shows has an OpenOrc app connected, read again whenever someone's apps come or go. */
export function useTeamChatPresence(): ReadonlyMap<string, TeamChatPresence["people"][number]["state"]> {
  const state = useTeamChatState();
  return teamChat.usePresence(useTeamChatContext(), state.data?.state === "ready" && state.data.chat.features.includes("presence"));
}
