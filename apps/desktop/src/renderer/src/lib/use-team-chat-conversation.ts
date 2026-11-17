import { useEffect, useState, useSyncExternalStore } from "react";
import type { TeamChatAnswered, TeamConversation } from "@openorc/protocol";
import type { TeamChatProps } from "../components/TeamChat";
import type { TeamChatRoute } from "./team-chat-route";
import type { TeamChatContextValue } from "./team-chat-context";
import { earlierTeamMessages, teamChatDrafts, useTeamChatTimeline } from "./team-chat-queries";
import { reactToTeamMessage, sendTeamMessage } from "./team-chat-actions";
import { useNewFrom, useTeamChatSeen } from "./team-chat-seen";
import { jumpToTeamMessage, useTeamMessageReveal } from "./team-chat-jump";
import { answeredOf } from "./team-chat-replies";

export function useTeamChatConversation(
  scope: TeamChatContextValue,
  target: TeamChatRoute,
  conversation: TeamConversation,
  features: { unread: boolean; replies: boolean },
): Omit<TeamChatProps, "conversation" | "people" | "names"> {
  const timeline = useTeamChatTimeline(scope, target.conversationId, true);
  const newFrom = useNewFrom(conversation, features.unread);
  const seen = useTeamChatSeen(scope, target, conversation, features.unread && scope.reach !== "offline");
  const first = timeline.data?.messages[0]?.seq;
  // The reading place must be on the page before anything is acknowledged: fetch back to it first.
  const placeLoaded = newFrom === null || first === undefined || first <= newFrom + 1 || !timeline.data?.older;
  const draft = useSyncExternalStore(teamChatDrafts.subscribe, () => teamChatDrafts.read(target));
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const offline = scope.reach === "offline";
  useEffect(() => {
    // A failed page stops here with its notice; it is not retried in a loop.
    if (!placeLoaded && !loadingOlder && !actionError && scope.current()) void older();
    // `older` is recreated each render; the page it loads changes `placeLoaded`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeLoaded, loadingOlder, actionError]);
  useEffect(() => {
    if (timeline.data)
      teamChatDrafts.reconcile(
        target,
        timeline.data.messages.map((message) => message.id),
      );
  }, [timeline.data, target]);
  const revealing = useTeamMessageReveal({ target, page: timeline.data, paging: loadingOlder, failed: actionError !== null, loadOlder: () => void older() });
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
    onSend: (files) => {
      if (offline || !conversation.joined || !scope.current()) return;
      const message = teamChatDrafts.begin(target, files);
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
    newFrom,
    ...(placeLoaded && { onShown: seen }),
    onOlder: () => {
      void older();
    },
    ...revealing,
    ...replying(target, draft.replyTo, features.replies, conversation.joined),
    onReact: (message, emoji) => {
      void reactToTeamMessage(scope, target, message, emoji).catch((error) => {
        if (scope.current()) setActionError(error instanceof Error ? error.message : "The reaction couldn't be saved.");
      });
    },
  };
}

/** Answering a message from the composer, and showing the message a reply answers. */
const replying = (target: TeamChatRoute, replyTo: TeamChatAnswered | null, replies: boolean, joined: boolean): Pick<TeamChatProps, "replyTo" | "onReply" | "onCancelReply" | "onOpenAnswered"> =>
  replies && joined
    ? {
        replyTo,
        onReply: (message) => teamChatDrafts.reply(target, answeredOf(message)),
        onCancelReply: () => teamChatDrafts.reply(target, null),
        onOpenAnswered: (answered) => jumpToTeamMessage(target, answered),
      }
    : {};
