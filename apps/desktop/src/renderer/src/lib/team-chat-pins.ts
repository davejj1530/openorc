import { useQuery } from "@tanstack/react-query";
import type { TeamMessage } from "@openorc/protocol";
import { core } from "./rpc";
import { queryClient } from "./client";
import type { TeamChatContextValue } from "./team-chat-context";
import type { TeamChatTarget } from "./team-chat-draft";
import { receiveTeamMessage } from "./team-chat-queries";

export const chatPinsKey = (scope: TeamChatContextValue, id: string) => ["team-chat", scope.accountId, scope.spaceId, scope.generation, "pins", id];

/** A conversation's pins, refreshed by the same changes as its messages, so a pin anyone makes shows for everyone. */
export function useTeamChatPins(scope: TeamChatContextValue, conversationId: string, enabled: boolean) {
  return useQuery({
    queryKey: chatPinsKey(scope, conversationId),
    enabled,
    retry: false,
    gcTime: 0,
    meta: { tags: ["team-chat", `team-chat:${scope.spaceId}`, `team-chat:${scope.spaceId}:${conversationId}`] },
    queryFn: async ({ signal }) => {
      if (!scope.current() || signal.aborted) throw new Error("The chat changed. Open it again.");
      return core.call("teamChat.pins", { spaceId: scope.spaceId, conversationId });
    },
  });
}

export async function pinTeamMessage(scope: TeamChatContextValue, target: TeamChatTarget, message: TeamMessage, pinned: boolean): Promise<void> {
  if (!scope.current() || scope.reach !== "live") throw new Error(pinned ? "You're offline. Reconnect to pin." : "You're offline. Reconnect to unpin.");
  const result = await core.call("teamChat.pin", { spaceId: target.spaceId, conversationId: target.conversationId, messageId: message.id, pinned });
  if (!scope.current()) return;
  receiveTeamMessage(scope, result);
  await queryClient.invalidateQueries({ queryKey: chatPinsKey(scope, target.conversationId), exact: true });
}
