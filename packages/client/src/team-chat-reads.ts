import { useEffect, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import type { TeamChatPresence, TeamChatStatus, TeamChatTimeline } from "@openorc/protocol";
import { mergeTeamMessages } from "./team-chat.js";
import type { TeamChatContext, TeamChatLease } from "./team-chat-context.js";
import type { TeamChatTarget } from "./team-chat-drafts.js";
import { refreshTeamHistory } from "./team-chat-history.js";

type PresenceState = TeamChatPresence["people"][number]["state"];
const NO_PRESENCE: ReadonlyMap<string, PresenceState> = new Map();
const NO_SPACES: readonly string[] = [];
/** How long a chat out of view stays to show again at once, refreshed behind it, when the person comes back. */
const KEPT_MS = 10 * 60_000;

/** What a chat screen reads: each keyed by the lease it was read under, refreshed by the chat's own invalidations. */
export function teamChatReads(ctx: TeamChatContext) {
  return {
    /** The organization's chat: its features, people and conversations, under this lease alone. */
    useChatState(lease: TeamChatLease | null) {
      return useQuery(
        {
          queryKey: lease ? ctx.keys.state(lease) : ["team-chat", "unavailable"],
          enabled: Boolean(lease),
          retry: false,
          gcTime: KEPT_MS,
          meta: { tags: lease ? ctx.tags(lease) : [] },
          queryFn: async ({ signal }): Promise<TeamChatStatus> => {
            ctx.current(lease, signal);
            if (!lease) return { state: "unavailable" };
            const state = await ctx.connection.call("teamChat.state", { spaceId: lease.spaceId });
            ctx.current(lease, signal);
            if (state.state === "ready" && (state.accountId !== lease.accountId || state.spaceId !== lease.spaceId)) throw new Error("The account changed. Open this chat again.");
            return state;
          },
        },
        ctx.queryClient,
      );
    },

    /** A conversation's latest page, filled forward over what it missed when it reads again. */
    useTimeline(lease: TeamChatLease, conversationId: string, enabled = true) {
      const key = ctx.keys.timeline(lease, conversationId);
      return useQuery(
        {
          queryKey: key,
          enabled,
          retry: false,
          gcTime: KEPT_MS,
          meta: { tags: ctx.tags(lease, conversationId) },
          queryFn: ({ signal }) =>
            refreshTeamHistory(ctx.queryClient.getQueryData<TeamChatTimeline>(key), async (afterSeq) => {
              ctx.current(lease, signal);
              const page = await ctx.connection.call("teamChat.timeline", { spaceId: lease.spaceId, conversationId, ...(afterSeq === undefined ? {} : { afterSeq }) });
              ctx.current(lease, signal);
              return page;
            }),
        },
        ctx.queryClient,
      );
    },

    /** Follows a conversation live while it is shown, so its changes arrive as invalidations. */
    useWatch(lease: TeamChatLease, conversationId: string, enabled = true): void {
      useEffect(() => {
        if (!enabled || !lease.current()) return;
        const watch = { spaceId: lease.spaceId, conversationId, requestId: ctx.randomId() };
        void ctx.connection.call("teamChat.watch", watch).catch(() => undefined);
        return () => void ctx.connection.call("teamChat.unwatch", watch).catch(() => undefined);
      }, [lease, conversationId, enabled]);
    },

    /** The page before the earliest shown, joined to it. */
    async earlier(lease: TeamChatLease, conversationId: string): Promise<void> {
      const key = ctx.keys.timeline(lease, conversationId);
      const before = ctx.queryClient.getQueryData<TeamChatTimeline>(key)?.messages[0]?.seq;
      if (before === undefined) return;
      ctx.current(lease);
      const page = await ctx.connection.call("teamChat.timeline", { spaceId: lease.spaceId, conversationId, beforeSeq: before });
      ctx.current(lease);
      ctx.queryClient.setQueryData<TeamChatTimeline>(key, (old) => (old ? { ...old, messages: mergeTeamMessages(page.messages, old.messages), older: page.older } : undefined));
    },

    /** A conversation's draft: its words, the message it answers, the Orcling it calls, and its sends not yet confirmed. */
    useDraft(target: TeamChatTarget) {
      return useSyncExternalStore(ctx.drafts.subscribe, () => ctx.drafts.read(target));
    },

    /** A conversation's pins, refreshed by the same changes as its messages, so a pin anyone makes shows for everyone. */
    usePins(lease: TeamChatLease, conversationId: string, enabled = true) {
      return useQuery(
        {
          queryKey: ctx.keys.pins(lease, conversationId),
          enabled,
          retry: false,
          gcTime: KEPT_MS,
          meta: { tags: ctx.tags(lease, conversationId) },
          queryFn: async ({ signal }) => {
            ctx.current(lease, signal);
            return ctx.connection.call("teamChat.pins", { spaceId: lease.spaceId, conversationId });
          },
        },
        ctx.queryClient,
      );
    },
  };
}

/** What the organization's chat says beyond one conversation: messages that match, who is connected, where unread is. */
export function teamChatOrganizationReads(ctx: TeamChatContext) {
  return {
    /** Messages of the organization's conversations that the person may read and that match `q`, two letters or more. */
    useSearch(lease: TeamChatLease | null, q: string, enabled = true) {
      const words = q.trim();
      return useQuery(
        {
          queryKey: lease ? ctx.keys.search(lease, words) : ["team-chat", "unavailable", "search"],
          enabled: Boolean(lease) && enabled && words.length >= 2,
          retry: false,
          staleTime: 5_000,
          meta: { tags: lease ? ctx.tags(lease) : [] },
          queryFn: async ({ signal }) => {
            ctx.current(lease, signal);
            return ctx.connection.call("teamChat.search", { spaceId: lease!.spaceId, q: words });
          },
        },
        ctx.queryClient,
      );
    },

    /** Who of the organization has an OpenOrc app connected; nothing offline, where it isn't served, or while unknown. */
    usePresence(lease: TeamChatLease | null, served: boolean): ReadonlyMap<string, PresenceState> {
      const enabled = served && Boolean(lease) && lease?.reach !== "offline";
      const presence = useQuery(
        {
          queryKey: lease ? ctx.keys.presence(lease) : ["team-chat", "unavailable", "presence"],
          enabled,
          retry: false,
          meta: { tags: lease ? [`team-chat-presence:${lease.spaceId}`, `team-chat:${lease.spaceId}`] : [] },
          queryFn: async ({ signal }) => {
            ctx.current(lease, signal);
            const read = await ctx.connection.call("teamChat.presence", { spaceId: lease!.spaceId });
            return new Map(read.people.map((person) => [person.id, person.state] as const));
          },
        },
        ctx.queryClient,
      );
      return enabled && presence.data ? presence.data : NO_PRESENCE;
    },

    /** The account's organizations with unread chat, by id alone, for a switcher's mark. */
    useUnreadSpaces(accountId: string | null): readonly string[] {
      const read = useQuery(
        {
          queryKey: ["team-chat-unread", accountId],
          enabled: Boolean(accountId),
          retry: false,
          refetchOnWindowFocus: true,
          meta: { tags: ["team-chat-unread"] },
          queryFn: async () => (await ctx.connection.call("teamChat.unreadSpaces", {})).spaceIds,
        },
        ctx.queryClient,
      );
      return accountId ? (read.data ?? NO_SPACES) : NO_SPACES;
    },
  };
}
