import { useEffect } from "react";
import type { TeamChatRoute } from "../lib/team-chat-route";
import { useTeamChatContext, type TeamChatContextValue } from "../lib/team-chat-context";
import { chatTimelineKey, teamChatDrafts, useTeamChatState, useTeamChatWatch } from "../lib/team-chat-queries";
import { queryClient } from "../lib/client";
import { useThreadTabs } from "../lib/thread-tabs";
import { TopBar } from "../components/TopBar";
import { ThreadTabs } from "../components/ThreadTabs";
import { TeamChatConversation } from "../components/TeamChatConversation";
import { CoversPreview } from "../lib/browser-preview";
import { useTeamChatVisible } from "../lib/team-chat-visibility";
import { Loader2 } from "../components/icons";
import { Button } from "../components/ui";

export function TeamChatView({ target }: { target: TeamChatRoute }) {
  const scope = useTeamChatContext();
  const visible = useTeamChatVisible();
  const allowed = scope && target.accountId === scope.accountId && target.spaceId === scope.spaceId && scope.current();
  return (
    <>
      {visible ? <CoversPreview /> : null}
      {allowed ? <AuthorizedChat key={JSON.stringify([target, scope.generation])} scope={scope} target={target} /> : <ChatUnavailable />}
    </>
  );
}

function AuthorizedChat({ scope, target }: { scope: TeamChatContextValue; target: TeamChatRoute }) {
  const state = useTeamChatState();
  const chat = state.data?.state === "ready" ? state.data.chat : undefined;
  const conversation = chat?.conversations.find((conversation) => conversation.id === target.conversationId);
  const lost = Boolean(chat && !conversation);
  const channels = chat?.features.includes("channels") ?? false;
  useTeamChatWatch(scope, target.conversationId, Boolean(conversation));
  useEffect(() => {
    if (!lost) return;
    teamChatDrafts.forget(target);
    queryClient.removeQueries({ queryKey: chatTimelineKey(scope, target.conversationId), exact: true });
  }, [lost, scope, target]);
  if (lost) return <ChatUnavailable />;
  if (conversation?.joined === false && !channels) return <ChatUnavailable message="This chat isn't available here." />;
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
  return <TeamChatConversation scope={scope} target={target} conversation={conversation} people={chat?.people ?? []} channels={channels} groups={chat?.features.includes("groups") ?? false} />;
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
        <Button size="sm" onClick={close}>
          Close chat
        </Button>
      </div>
    </main>
  );
}
function ChatWaiting({ error, onRetry }: { error: string | null; onRetry(): void }) {
  return (
    <main className="well flex-1 min-w-0 flex flex-col team-chat">
      <TopBar tabs>
        <ThreadTabs />
      </TopBar>
      <div className="team-chat-state" role="status">
        {!error ? <Loader2 size={16} className="animate-spin" /> : null}
        <p>{error ?? "Loading chat…"}</p>
        {error ? (
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </div>
    </main>
  );
}
