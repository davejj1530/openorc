import { useEffect, useState, useSyncExternalStore } from "react";
import type { TeamConversation } from "@openorc/protocol";
import type { TeamChatProps } from "../components/TeamChat";
import type { TeamChatRoute } from "./team-chat-route";
import type { TeamChatContextValue } from "./team-chat-context";
import { earlierTeamMessages, teamChatDrafts, useTeamChatTimeline } from "./team-chat-queries";
import { reactToTeamMessage, sendTeamMessage } from "./team-chat-actions";

export function useTeamChatConversation(scope: TeamChatContextValue, target: TeamChatRoute, conversation: TeamConversation): Omit<TeamChatProps, "conversation" | "people" | "names"> {
  const timeline = useTeamChatTimeline(scope, target.conversationId, true);
  const draft = useSyncExternalStore(teamChatDrafts.subscribe, () => teamChatDrafts.read(target));
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const offline = scope.reach === "offline";
  useEffect(() => {
    if (timeline.data)
      teamChatDrafts.reconcile(
        target,
        timeline.data.messages.map((message) => message.id),
      );
  }, [timeline.data, target]);
  const older = async () => {
    setLoadingOlder(true);
    setActionError(null);
    try {
      await earlierTeamMessages(scope, target);
    } catch (error) {
      if (scope.current()) setActionError(error instanceof Error ? error.message : "Earlier messages couldn't be loaded.");
    } finally {
      setLoadingOlder(false);
    }
  };
  return {
    self: target.accountId,
    messages: timeline.data?.messages ?? [],
    pending: conversation.joined ? draft.pending : [],
    draft: draft.text,
    loading: timeline.isPending,
    error: timeline.error && !offline ? timeline.error.message : null,
    ...(actionError && { notice: { message: actionError, dismiss: () => setActionError(null) } }),
    reason: offline ? "Reconnect to send" : null,
    onDraft: (text) => teamChatDrafts.write(target, text),
    onSend: () => {
      if (offline || !conversation.joined || !scope.current()) return;
      const message = teamChatDrafts.begin(target);
      if (message) void sendTeamMessage(scope, target, message);
    },
    onRetry: (message) => {
      if (conversation.joined) void sendTeamMessage(scope, target, message);
    },
    onReload: () => {
      void timeline.refetch();
    },
    older: timeline.data?.older ?? false,
    loadingOlder,
    onOlder: () => {
      void older();
    },
    onReact: (message, emoji) => {
      void reactToTeamMessage(scope, target, message, emoji).catch((error) => {
        if (scope.current()) setActionError(error instanceof Error ? error.message : "The reaction couldn't be saved.");
      });
    },
  };
}
