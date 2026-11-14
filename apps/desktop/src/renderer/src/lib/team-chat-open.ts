import { useEffect, useRef, useState } from "react";
import type { TeamChatRow } from "@openorc/client";
import type { TeamChatStatus } from "@openorc/protocol";
import { useTeamChatContext, type TeamChatContextValue } from "./team-chat-context";
import { chatStateKey } from "./team-chat-queries";
import { core } from "./rpc";
import { queryClient } from "./client";
import { useRouter } from "./router";

/** Every entry opens the same canonical conversation without moving a later destination. */
export function useOpenTeamChat() {
  const scope = useTeamChatContext();
  const turn = useRef(0);
  const [opening, setOpening] = useState<{ scope: TeamChatContextValue; id: string } | null>(null);
  const [failure, setFailure] = useState<{ scope: TeamChatContextValue; row: TeamChatRow; message: string } | null>(null);
  useEffect(
    () => () => {
      turn.current++;
    },
    [scope],
  );
  const open = async (row: TeamChatRow): Promise<boolean> => {
    if (!scope?.current()) return false;
    const attempt = ++turn.current;
    const origin = useRouter.getState().route;
    const current = () => scope.current() && attempt === turn.current && useRouter.getState().route === origin;
    setOpening({ scope, id: row.id });
    setFailure(null);
    try {
      const conversation = row.kind === "person" ? await core.call("teamChat.openDm", { spaceId: scope.spaceId, userIds: [row.person.id] }) : row.conversation;
      if (!current()) return false;
      queryClient.setQueryData<TeamChatStatus>(chatStateKey(scope), (old) =>
        old?.state === "ready" ? { ...old, chat: { ...old.chat, conversations: [...old.chat.conversations.filter((item) => item.id !== conversation.id), conversation] } } : old,
      );
      useRouter.getState().navigate({ view: "team-chat", accountId: scope.accountId, spaceId: scope.spaceId, conversationId: conversation.id });
      return true;
    } catch (error) {
      if (current()) setFailure({ scope, row, message: error instanceof Error ? error.message : "Chat could not be opened." });
      return false;
    } finally {
      if (attempt === turn.current) setOpening(null);
    }
  };
  const failed = failure?.scope === scope && scope?.current() ? failure : null;
  return { opening: opening?.scope === scope ? (opening?.id ?? null) : null, error: failed?.message ?? null, open, retry: () => (failed ? open(failed.row) : Promise.resolve(false)) };
}
