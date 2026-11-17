import type { QueryClient } from "@tanstack/react-query";
import type { TeamChatRead, TeamChatStatus, TeamChatTimeline, TeamMessage } from "@openorc/protocol";
import type { CoreConnection } from "./connection.js";
import { mergeTeamMessages, type TeamChatScope } from "./team-chat.js";
import { TeamChatDrafts, type TeamChatDraftStorage } from "./team-chat-drafts.js";

/**
 * A lease on one account's organization chat, held while the screen shows it: whatever it read stops counting once
 * `current()` turns false (the account, the organization or the person's access to it changed).
 */
export interface TeamChatLease extends TeamChatScope {
  generation: number;
  reach: "live" | "offline";
  current(): boolean;
}

export interface TeamChatDeps {
  connection: CoreConnection;
  queryClient: QueryClient;
  storage: TeamChatDraftStorage;
  randomId(): string;
}

const CHANGED = "The chat changed. Open it again.";

/** What the chat's reads and writes share: one connection, one cache keyed by lease, and one place for drafts. */
export function teamChatContext({ connection, queryClient, storage, randomId }: TeamChatDeps) {
  const drafts = new TeamChatDrafts(storage, randomId);
  const base = (lease: TeamChatLease) => ["team-chat", lease.accountId, lease.spaceId, lease.generation] as const;
  const keys = {
    state: (lease: TeamChatLease) => [...base(lease), "state"],
    timeline: (lease: TeamChatLease, conversationId: string) => [...base(lease), "timeline", conversationId],
    pins: (lease: TeamChatLease, conversationId: string) => [...base(lease), "pins", conversationId],
    presence: (lease: TeamChatLease) => [...base(lease), "presence"],
    search: (lease: TeamChatLease, q: string) => [...base(lease), "search", q],
    call: (lease: TeamChatLease, callId: string) => [...base(lease), "call", callId],
  };
  /** Stops a read or write whose lease has lapsed, or whose screen has moved on. */
  function current(lease: TeamChatLease | null, signal?: { readonly aborted: boolean }): void {
    if (!lease?.current() || signal?.aborted) throw new Error(CHANGED);
  }
  return {
    connection,
    queryClient,
    randomId,
    drafts,
    keys,
    current,
    tags: (lease: TeamChatLease, conversationId?: string) => ["team-chat", `team-chat:${lease.spaceId}`, ...(conversationId ? [`team-chat:${lease.spaceId}:${conversationId}`] : [])],
    /** Stops a write that needs the server now, with the words for being offline. */
    live(lease: TeamChatLease, offline: string): void {
      if (!lease.current() || lease.reach !== "live") throw new Error(offline);
    },
    /** A message the server confirmed, into the conversation's page and out of its unsent ones. */
    receive(lease: TeamChatLease, message: TeamMessage): void {
      if (!lease.current()) return;
      queryClient.setQueryData<TeamChatTimeline>(keys.timeline(lease, message.channelId), (old) => (old ? { ...old, messages: mergeTeamMessages(old.messages, [message]) } : undefined));
      drafts.reconcile({ accountId: lease.accountId, spaceId: lease.spaceId, conversationId: message.channelId }, [message.id]);
    },
    /** The read place the server now holds, into the conversation list, never behind what it showed. */
    storeRead(lease: TeamChatLease, conversationId: string, read: TeamChatRead): void {
      if (!lease.current()) return;
      queryClient.setQueryData<TeamChatStatus>(keys.state(lease), (state) =>
        state?.state === "ready"
          ? {
              ...state,
              chat: { ...state.chat, conversations: state.chat.conversations.map((item) => (item.id === conversationId && (item.read?.seenSeq ?? 0) <= read.seenSeq ? { ...item, read } : item)) },
            }
          : state,
      );
    },
  };
}
export type TeamChatContext = ReturnType<typeof teamChatContext>;
