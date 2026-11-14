import { useQuery } from "@tanstack/react-query";
import { core } from "./rpc";

const NONE: readonly string[] = [];

/**
 * The account's organizations with unread chat, for the switcher's one neutral mark. Only identifiers; the server says
 * nothing until the unread capability is advertised, and focus repairs a missed invalidation.
 */
export function useUnreadChatSpaces(accountId: string | null): readonly string[] {
  const read = useQuery({
    queryKey: ["team-chat-unread", accountId],
    enabled: Boolean(accountId),
    retry: false,
    refetchOnWindowFocus: true,
    meta: { tags: ["team-chat-unread"] },
    queryFn: async () => (await core.call("teamChat.unreadSpaces", {})).spaceIds,
  });
  return accountId ? (read.data ?? NONE) : NONE;
}
