import { Command } from "cmdk";
import { useQuery } from "@tanstack/react-query";
import { rowAge, teamConversationTitle, useSidebarNow } from "@openorc/client";
import type { TeamChatSearchHit, TeamConversation } from "@openorc/protocol";
import { core } from "../lib/rpc";
import { useTeamChatContext, type TeamChatContextValue } from "../lib/team-chat-context";
import { useTeamChatState } from "../lib/team-chat-queries";
import { openTeamConversation } from "../lib/team-chat-open";
import { jumpToTeamMessage } from "../lib/team-chat-jump";
import { TeamChatFace } from "./TeamChatFace";
import "../styles/team-chat-search.css";

/** Searching starts at two characters, as message search in threads does. */
const SHORTEST = 2;

/** Messages of the organization's chat that match, in the conversations the person may read, each with its writer's face and where it is; each opens in place. */
export function TeamChatSearchHits({ query, onOpened }: { query: string; onOpened(): void }) {
  const scope = useTeamChatContext();
  const state = useTeamChatState();
  const chat = state.data?.state === "ready" ? state.data.chat : null;
  const q = query.trim();
  const hits = useTeamChatSearch(scope, q, Boolean(chat?.features.includes("search")) && q.length >= SHORTEST);
  const now = useSidebarNow();
  if (!scope || !chat) return null;
  if (hits.error)
    return (
      <Command.Group heading="Chat messages" className="command-palette-group">
        <Command.Item value={`chat message ${q} search again`} onSelect={() => void hits.refetch()} className="command-palette-item" role="status">
          <span className="command-palette-label">{hits.error.message}</span>
          <span className="command-palette-place">Try again</span>
        </Command.Item>
      </Command.Group>
    );
  if (!hits.data?.hits.length) return null;
  const conversations = new Map(chat.conversations.map((conversation) => [conversation.id, conversation]));
  const open = (hit: TeamChatSearchHit, conversation: TeamConversation) => {
    jumpToTeamMessage({ accountId: scope.accountId, spaceId: scope.spaceId, conversationId: conversation.id }, hit);
    openTeamConversation(scope, conversation);
    onOpened();
  };
  return (
    <Command.Group heading="Chat messages" className="command-palette-group">
      {hits.data.hits.flatMap((hit) => {
        const conversation = conversations.get(hit.channelId);
        if (!conversation) return [];
        const where = conversation.kind === "channel" ? `#${teamConversationTitle(conversation, scope.accountId)}` : teamConversationTitle(conversation, scope.accountId);
        return [
          <Command.Item key={hit.id} value={`chat message ${q} ${hit.snippet.text} ${hit.id}`} onSelect={() => open(hit, conversation)} className="command-palette-item">
            <span className="command-palette-icon">
              <TeamChatFace people={[hit.person ?? { id: "", name: "Former member", image: null }]} />
            </span>
            <span className="command-palette-label">{hit.snippet.text}</span>
            <span className="command-palette-place team-chat-search-place">{where}</span>
            <span className="command-palette-age tabular">{rowAge(Date.parse(hit.createdAt), now)}</span>
          </Command.Item>,
        ];
      })}
    </Command.Group>
  );
}

function useTeamChatSearch(scope: TeamChatContextValue | null, q: string, enabled: boolean) {
  return useQuery({
    queryKey: ["team-chat", scope?.accountId, scope?.spaceId, scope?.generation, "search", q],
    enabled: Boolean(scope) && enabled,
    retry: false,
    staleTime: 5_000,
    meta: { tags: scope ? ["team-chat", `team-chat:${scope.spaceId}`] : [] },
    queryFn: async ({ signal }) => {
      if (!scope?.current() || signal.aborted) throw new Error("The chat changed. Search again.");
      return core.call("teamChat.search", { spaceId: scope.spaceId, q });
    },
  });
}
