import { useQuery } from "@tanstack/react-query";
import type { TeamChatPresence } from "@openorc/protocol";
import { core } from "./rpc";
import { useTeamChatContext } from "./team-chat-context";
import { useTeamChatState } from "./team-chat-queries";

type State = TeamChatPresence["people"][number]["state"];
const NONE: ReadonlyMap<string, State> = new Map();

/**
 * Who of the organization has an OpenOrc app connected, read again whenever someone's apps come or go. Nothing is
 * known offline, where the server doesn't serve presence, or outside an organization's chat.
 */
export function useTeamChatPresence(): ReadonlyMap<string, State> {
  const scope = useTeamChatContext();
  const state = useTeamChatState();
  const served = state.data?.state === "ready" && state.data.chat.features.includes("presence");
  const live = Boolean(scope) && scope?.reach !== "offline";
  const presence = useQuery({
    queryKey: ["team-chat", scope?.accountId, scope?.spaceId, scope?.generation, "presence"],
    enabled: served && live,
    retry: false,
    meta: { tags: scope ? [`team-chat-presence:${scope.spaceId}`, `team-chat:${scope.spaceId}`] : [] },
    queryFn: async ({ signal }) => {
      if (!scope?.current() || signal.aborted) throw new Error("The chat changed.");
      const read = await core.call("teamChat.presence", { spaceId: scope.spaceId });
      return new Map(read.people.map((person) => [person.id, person.state] as const));
    },
  });
  return served && live && presence.data ? presence.data : NONE;
}
