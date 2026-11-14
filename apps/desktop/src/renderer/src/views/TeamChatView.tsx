import { useEffect, useState, useSyncExternalStore } from "react";
import type { TeamConversation } from "@openorc/protocol";
import type { TeamChatRoute } from "../lib/team-chat-route";
import { useTeamChatContext, type TeamChatContextValue } from "../lib/team-chat-context";
import { chatTimelineKey, earlierTeamMessages, teamChatDrafts, useTeamChatState, useTeamChatTimeline, useTeamChatWatch } from "../lib/team-chat-queries";
import { reactToTeamMessage, sendTeamMessage } from "../lib/team-chat-actions";
import { queryClient } from "../lib/client";
import { useThreadTabs } from "../lib/thread-tabs";
import { TopBar } from "../components/TopBar";
import { ThreadTabs } from "../components/ThreadTabs";
import { TeamChat } from "../components/TeamChat";

export function TeamChatView({ target }: { target: TeamChatRoute }) {
  const scope = useTeamChatContext();
  if (!scope || target.accountId !== scope.accountId || target.spaceId !== scope.spaceId || !scope.current()) return <ChatUnavailable />;
  return <AuthorizedChat key={JSON.stringify([target, scope.generation])} scope={scope} target={target} />;
}

function AuthorizedChat({ scope, target }: { scope: TeamChatContextValue; target: TeamChatRoute }) {
  const state = useTeamChatState();
  const conversation = state.data?.state === "ready" ? state.data.chat.conversations.find((conversation) => conversation.id === target.conversationId) : undefined;
  const timeline = useTeamChatTimeline(scope, target.conversationId, Boolean(conversation));
  const draft = useSyncExternalStore(teamChatDrafts.subscribe, () => teamChatDrafts.read(target));
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const lost = state.data?.state === "ready" && !conversation;
  useTeamChatWatch(scope, target.conversationId, Boolean(conversation));
  useEffect(() => {
    if (!lost) return;
    teamChatDrafts.forget(target);
    queryClient.removeQueries({ queryKey: chatTimelineKey(scope, target.conversationId), exact: true });
  }, [lost, scope, target]);
  useEffect(() => {
    if (timeline.data)
      teamChatDrafts.reconcile(
        target,
        timeline.data.messages.map((message) => message.id),
      );
  }, [timeline.data, target]);
  if (lost) return <ChatUnavailable />;
  if (state.data?.state === "unavailable") return <ChatUnavailable message="Chat isn't available here." />;
  if (!conversation)
    return (
      <ChatWaiting
        error={state.error?.message ?? null}
        onRetry={() => {
          void state.refetch();
        }}
      />
    );
  const offline = scope.reach === "offline";
  const error = timeline.error && !offline ? timeline.error.message : null;
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
  return (
    <>
      <TeamChat
        conversation={conversation}
        self={target.accountId}
        people={state.data?.state === "ready" ? state.data.chat.people : []}
        names={showsSpeakerNames(conversation)}
        messages={timeline.data?.messages ?? []}
        pending={draft.pending}
        draft={draft.text}
        loading={timeline.isPending}
        error={error}
        {...(actionError && { notice: { message: actionError, dismiss: () => setActionError(null) } })}
        reason={offline ? "You're offline. Reconnect to send." : null}
        onDraft={(text) => teamChatDrafts.write(target, text)}
        onSend={() => {
          if (offline || !scope.current()) return;
          const message = teamChatDrafts.begin(target);
          if (message) void sendTeamMessage(scope, target, message);
        }}
        onRetry={(message) => {
          void sendTeamMessage(scope, target, message);
        }}
        onReload={() => {
          void timeline.refetch();
        }}
        older={timeline.data?.older ?? false}
        loadingOlder={loadingOlder}
        onOlder={() => {
          void older();
        }}
        onReact={(message, emoji) => {
          void reactToTeamMessage(scope, target, message, emoji).catch((error) => {
            if (scope.current()) setActionError(error instanceof Error ? error.message : "The reaction couldn't be saved.");
          });
        }}
      />
    </>
  );
}

function ChatUnavailable({ message = "You no longer have access to this chat." }: { message?: string }) {
  const close = () => {
    const { active, close } = useThreadTabs.getState();
    if (active) close(active);
  };
  return (
    <main className="well flex-1 min-w-0 flex flex-col team-chat">
      <TopBar tabs>
        <ThreadTabs />
      </TopBar>
      <div className="team-chat-state">
        <p>{message}</p>
        <button type="button" onClick={close}>
          Close chat
        </button>
      </div>
    </main>
  );
}
function showsSpeakerNames(conversation: TeamConversation): boolean {
  return conversation.kind === "channel" || (conversation.participants?.length ?? 0) > 2;
}
function ChatWaiting({ error, onRetry }: { error: string | null; onRetry(): void }) {
  return (
    <main className="well flex-1 min-w-0 flex flex-col team-chat">
      <TopBar tabs>
        <ThreadTabs />
      </TopBar>
      <div className="team-chat-state" role="status">
        <p>{error ?? "Loading chat…"}</p>
        {error ? (
          <button type="button" onClick={onRetry}>
            Try again
          </button>
        ) : null}
      </div>
    </main>
  );
}
