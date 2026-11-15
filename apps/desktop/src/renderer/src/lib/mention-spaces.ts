import { useQuery } from "@tanstack/react-query";
import { queryClient } from "./client";
import { core } from "./rpc";

const NONE: readonly string[] = [];

/**
 * The account's organizations with a note that tags the person unread, for the switcher's one neutral dot. Only
 * identifiers, read again on any thread change and on focus; an older server names none.
 */
export function useMentionSpaces(accountId: string | null): readonly string[] {
  const read = useQuery(
    {
      queryKey: ["spaces.mentions", accountId],
      enabled: Boolean(accountId),
      retry: false,
      refetchOnWindowFocus: true,
      meta: { tags: ["mentions", "threads"] },
      queryFn: async () => (await core.call("spaces.mentions", {})).spaceIds,
    },
    // The app's own client, so a switcher drawn without a provider still reads it.
    queryClient,
  );
  return accountId ? (read.data ?? NONE) : NONE;
}
