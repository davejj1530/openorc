import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { mergeTeamMessages } from "@openorc/client";
import type { TeamMessage, TeamChatTimeline } from "@openorc/protocol";
import { core } from "./rpc";
import { queryClient } from "./client";
import { useTeamChatContext, type TeamChatContextValue } from "./team-chat-context";
import { TeamChatDrafts, type TeamChatTarget } from "./team-chat-draft";
import { refreshTeamHistory } from "./team-chat-history";

export const teamChatDrafts = new TeamChatDrafts(localStorage);
export const chatStateKey = (scope: TeamChatContextValue) => ["team-chat", scope.accountId, scope.spaceId, scope.generation, "state"];
export const chatTimelineKey = (scope: TeamChatContextValue, id: string) => ["team-chat", scope.accountId, scope.spaceId, scope.generation, "timeline", id];
const current = (scope: TeamChatContextValue | null, signal?: AbortSignal) => {
  if (!scope?.current() || signal?.aborted) throw new Error("The chat changed. Open it again.");
};
const tags = (scope: TeamChatContextValue | null) => (scope ? ["team-chat", `team-chat:${scope.spaceId}`] : []);

export function useTeamChatState() {
  const scope = useTeamChatContext();
  return useQuery({
    queryKey: scope ? chatStateKey(scope) : ["team-chat", "unavailable"],
    enabled: Boolean(scope),
    retry: false,
    gcTime: 0,
    meta: { tags: tags(scope) },
    queryFn: async ({ signal }) => {
      current(scope, signal);
      if (!scope) return { state: "unavailable" as const };
      const state = await core.call("teamChat.state", { spaceId: scope.spaceId });
      current(scope, signal);
      if (state.state === "ready" && (state.accountId !== scope.accountId || state.spaceId !== scope.spaceId)) throw new Error("The account changed. Open this chat again.");
      return state;
    },
  });
}

export function useTeamChatTimeline(scope: TeamChatContextValue, conversationId: string, enabled: boolean) {
  const key = chatTimelineKey(scope, conversationId);
  return useQuery({
    queryKey: key,
    enabled,
    retry: false,
    gcTime: 0,
    meta: { tags: [...tags(scope), `team-chat:${scope.spaceId}:${conversationId}`] },
    queryFn: async ({ signal }) => {
      const prior = queryClient.getQueryData<TeamChatTimeline>(key);
      return refreshTeamHistory(prior, async (afterSeq) => {
        current(scope, signal);
        const page = await core.call("teamChat.timeline", { spaceId: scope.spaceId, conversationId, ...(afterSeq === undefined ? {} : { afterSeq }) });
        current(scope, signal);
        return page;
      });
    },
  });
}

export function receiveTeamMessage(scope: TeamChatContextValue, message: TeamMessage): void {
  if (!scope.current()) return;
  queryClient.setQueryData<TeamChatTimeline>(chatTimelineKey(scope, message.channelId), (old) => (old ? { ...old, messages: mergeTeamMessages(old.messages, [message]) } : undefined));
  teamChatDrafts.reconcile({ ...scope, conversationId: message.channelId }, [message.id]);
}

export function useTeamChatWatch(scope: TeamChatContextValue, conversationId: string, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !scope.current()) return;
    const watch = { spaceId: scope.spaceId, conversationId, requestId: crypto.randomUUID() };
    void core.call("teamChat.watch", watch).catch(() => undefined);
    return () => {
      void core.call("teamChat.unwatch", watch).catch(() => undefined);
    };
  }, [scope, conversationId, enabled]);
}

export async function earlierTeamMessages(scope: TeamChatContextValue, target: TeamChatTarget): Promise<void> {
  const key = chatTimelineKey(scope, target.conversationId);
  const before = queryClient.getQueryData<TeamChatTimeline>(key)?.messages[0]?.seq;
  if (before === undefined) return;
  current(scope);
  const page = await core.call("teamChat.timeline", { spaceId: target.spaceId, conversationId: target.conversationId, beforeSeq: before });
  current(scope);
  queryClient.setQueryData<TeamChatTimeline>(key, (old) => (old ? { ...old, messages: mergeTeamMessages(page.messages, old.messages), older: page.older } : undefined));
}
