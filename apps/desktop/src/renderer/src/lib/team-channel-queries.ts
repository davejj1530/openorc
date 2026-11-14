import { useQuery } from "@tanstack/react-query";
import { core } from "./rpc";
import type { TeamChatContextValue } from "./team-chat-context";

export const channelDetailsKey = (scope: TeamChatContextValue, id: string) => ["team-chat", scope.accountId, scope.spaceId, scope.generation, "details", id];

export function useTeamChannelDetails(scope: TeamChatContextValue, conversationId: string) {
  return useQuery({
    queryKey: channelDetailsKey(scope, conversationId),
    retry: false,
    gcTime: 0,
    meta: { tags: ["team-chat", `team-chat:${scope.spaceId}`, `team-chat:${scope.spaceId}:${conversationId}`] },
    queryFn: async ({ signal }) => {
      const current = () => {
        if (!scope.current() || signal.aborted) throw new Error("This chat changed. Open it again.");
      };
      current();
      const conversation = await core.call("teamChat.conversation", { spaceId: scope.spaceId, conversationId });
      current();
      return conversation;
    },
  });
}
