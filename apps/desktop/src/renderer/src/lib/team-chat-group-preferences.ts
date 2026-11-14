import { useLayoutEffect, useSyncExternalStore } from "react";
import { teamChatRoster } from "@openorc/client";
import type { TeamChatState, TeamConversation } from "@openorc/protocol";
import type { TeamChatContextValue } from "./team-chat-context";
import { TeamChatClosedGroups } from "./team-chat-closed-groups";
import { useThreadTabs } from "./thread-tabs";

export const teamChatClosedGroups = new TeamChatClosedGroups(localStorage);

export function useTeamChatRoster(scope: TeamChatContextValue | null, state?: TeamChatState) {
  useSyncExternalStore(teamChatClosedGroups.subscribe, teamChatClosedGroups.getSnapshot);
  useLayoutEffect(() => {
    if (scope?.current() && state) teamChatClosedGroups.reconcile(scope, state.conversations);
  }, [scope, state]);
  if (!scope || !state) return [];
  return teamChatRoster(state, scope.accountId).filter((row) => row.kind === "person" || !teamChatClosedGroups.isClosed(scope, row.conversation));
}

export function closeTeamGroup(scope: TeamChatContextValue, conversation: TeamConversation): void {
  if (!scope.current() || !teamChatClosedGroups.close(scope, conversation)) return;
  closeTeamChatTab(scope, conversation.id);
}

export function closeTeamChatTab(scope: TeamChatContextValue, conversationId: string): void {
  if (!scope.current()) return;
  const tab = useThreadTabs
    .getState()
    .tabs.find(({ route }) => route.view === "team-chat" && route.accountId === scope.accountId && route.spaceId === scope.spaceId && route.conversationId === conversationId);
  if (tab) useThreadTabs.getState().close(tab.id);
}
