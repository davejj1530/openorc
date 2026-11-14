import { useRef, useState } from "react";
import { teamChatRoster, type TeamChatRow } from "@openorc/client";
import type { TeamChatStatus } from "@openorc/protocol";
import { useTeamChatContext } from "../lib/team-chat-context";
import { chatStateKey, useTeamChatState } from "../lib/team-chat-queries";
import { core } from "../lib/rpc";
import { queryClient } from "../lib/client";
import { useRouter } from "../lib/router";
import { SidebarChat } from "./SidebarChat";

/** The sidebar entry waits for the account's authorized capability and roster. */
export function OrganizationChat() {
  const scope = useTeamChatContext();
  const state = useTeamChatState();
  const route = useRouter((s) => s.route);
  const [opening, setOpening] = useState<TeamChatRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const turn = useRef(0);
  const open = async (row: TeamChatRow) => {
    if (!scope?.current()) return;
    const attempt = ++turn.current;
    const origin = useRouter.getState().route;
    setOpening(row);
    setError(null);
    try {
      const conversation = row.kind === "person" ? await core.call("teamChat.openDm", { spaceId: scope.spaceId, userIds: [row.person.id] }) : row.conversation;
      if (!scope.current() || attempt !== turn.current || useRouter.getState().route !== origin) return;
      queryClient.setQueryData<TeamChatStatus>(chatStateKey(scope), (old) =>
        old?.state === "ready" ? { ...old, chat: { ...old.chat, conversations: [...old.chat.conversations.filter((item) => item.id !== conversation.id), conversation] } } : old,
      );
      useRouter.getState().navigate({ view: "team-chat", accountId: scope.accountId, spaceId: scope.spaceId, conversationId: conversation.id });
      setOpening(null);
    } catch (error) {
      if (scope.current() && attempt === turn.current) setError(error instanceof Error ? error.message : "Chat could not be opened.");
    }
  };
  if (!scope || state.data?.state === "unavailable") return null;
  if (state.data?.state !== "ready")
    return state.error ? (
      <SidebarChat
        rows={[]}
        self={scope.accountId}
        selected={null}
        opening={null}
        error={state.error.message}
        onOpen={() => {}}
        onRetry={() => {
          void state.refetch();
        }}
      />
    ) : null;
  return (
    <SidebarChat
      rows={teamChatRoster(state.data.chat, scope.accountId)}
      self={scope.accountId}
      selected={route.view === "team-chat" ? route.conversationId : null}
      opening={error ? null : (opening?.id ?? null)}
      error={error}
      onOpen={(row) => {
        void open(row);
      }}
      onRetry={() => {
        if (opening) void open(opening);
      }}
    />
  );
}
