import { useEffect, useRef, useState } from "react";
import type { TeamChatStatus, TeamConversation } from "@openorc/protocol";
import { queryClient } from "./client";
import { useRouter } from "./router";
import { chatStateKey } from "./team-chat-queries";
import type { TeamChatContextValue } from "./team-chat-context";
import { useThreadTabs } from "./thread-tabs";

export function refreshTeamChannels(scope: TeamChatContextValue): Promise<void> {
  if (!scope.current()) return Promise.resolve();
  return queryClient.invalidateQueries({ queryKey: ["team-chat", scope.accountId, scope.spaceId, scope.generation] });
}

/** A dialog may finish a write, but cannot take over a later space or destination. */
export function useTeamChannelAction(scope: TeamChatContextValue) {
  const turn = useRef(0);
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(
    () => () => {
      turn.current++;
    },
    [],
  );
  const run = async <T>(work: () => Promise<T>, done: (value: T) => void = () => {}): Promise<boolean> => {
    if (busy.current || !scope.current() || scope.reach === "offline") return false;
    const attempt = ++turn.current;
    const origin = useRouter.getState().route;
    const current = () => scope.current() && attempt === turn.current && useRouter.getState().route === origin;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const value = await work();
      if (!current()) return false;
      done(value);
      return true;
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : "The channel couldn't be updated.");
      return false;
    } finally {
      void refreshTeamChannels(scope);
      if (attempt === turn.current) {
        busy.current = false;
        setPending(false);
      }
    }
  };
  return { pending, error, run };
}

export function openCreatedChannel(scope: TeamChatContextValue, conversation: TeamConversation): void {
  if (!scope.current()) return;
  queryClient.setQueryData<TeamChatStatus>(chatStateKey(scope), (state) =>
    state?.state === "ready" ? { ...state, chat: { ...state.chat, conversations: [...state.chat.conversations.filter((item) => item.id !== conversation.id), conversation] } } : state,
  );
  useRouter.getState().navigate({ view: "team-chat", accountId: scope.accountId, spaceId: scope.spaceId, conversationId: conversation.id });
}

export function closeTeamChannel(scope: TeamChatContextValue, conversationId: string): void {
  if (!scope.current()) return;
  const tab = useThreadTabs
    .getState()
    .tabs.find(({ route }) => route.view === "team-chat" && route.accountId === scope.accountId && route.spaceId === scope.spaceId && route.conversationId === conversationId);
  if (tab) useThreadTabs.getState().close(tab.id);
}
