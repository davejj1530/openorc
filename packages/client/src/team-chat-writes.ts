import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { PendingTeamMessage, TeamChatOrclingPick, TeamChatReaction, TeamMessage, TeamOrclingCall } from "@openorc/protocol";
import { tagsFor } from "./query-tags.js";
import type { TeamChatContext, TeamChatLease } from "./team-chat-context.js";
import type { TeamChatTarget } from "./team-chat-drafts.js";

/** What a chat screen changes: each write goes to the connection, and what the server confirms joins the shown page. */
export function teamChatWrites(ctx: TeamChatContext) {
  return {
    /** Sends a message the draft began, or tries a failed one again with the same id, so it is sent once. */
    async send(lease: TeamChatLease, target: TeamChatTarget, message: PendingTeamMessage): Promise<void> {
      if (!lease.current() || lease.reach !== "live") return;
      ctx.drafts.attempt(target, message.id);
      try {
        const sent = await ctx.connection.call("teamChat.send", {
          spaceId: target.spaceId,
          conversationId: target.conversationId,
          id: message.id,
          body: message.body,
          ...(message.files.length && { fileIds: message.files.map((file) => file.id) }),
          ...(message.replyTo && { replyToId: message.replyTo.id }),
          ...(message.orcling && { orcling: { callId: message.orcling.callId, localOrclingId: message.orcling.localOrclingId } }),
        });
        if (!lease.current()) return ctx.drafts.failed(target, message.id, "Delivery couldn't be confirmed.");
        ctx.receive(lease, sent);
      } catch (error) {
        ctx.drafts.failed(target, message.id, error instanceof Error ? error.message : "Delivery couldn't be confirmed.");
      }
    },

    async react(lease: TeamChatLease, target: TeamChatTarget, message: TeamMessage, emoji: TeamChatReaction): Promise<void> {
      ctx.live(lease, "You're offline. Reconnect to react.");
      ctx.receive(lease, await ctx.connection.call("teamChat.react", { spaceId: target.spaceId, conversationId: target.conversationId, messageId: message.id, emoji }));
    },

    async pin(lease: TeamChatLease, target: TeamChatTarget, message: TeamMessage, pinned: boolean): Promise<void> {
      ctx.live(lease, pinned ? "You're offline. Reconnect to pin." : "You're offline. Reconnect to unpin.");
      const result = await ctx.connection.call("teamChat.pin", { spaceId: target.spaceId, conversationId: target.conversationId, messageId: message.id, pinned });
      if (!lease.current()) return;
      ctx.receive(lease, result);
      await ctx.queryClient.invalidateQueries({ queryKey: ctx.keys.pins(lease, target.conversationId), exact: true });
    },

    /** Moves the read place forward to a message the person saw; the list's count follows what the server holds. */
    async seen(lease: TeamChatLease, target: TeamChatTarget, message: Pick<TeamMessage, "id">): Promise<void> {
      ctx.current(lease);
      ctx.storeRead(lease, target.conversationId, await ctx.connection.call("teamChat.seen", { spaceId: target.spaceId, conversationId: target.conversationId, messageId: message.id }));
    },

    /** The person's own Orclings a conversation can call, from the Mac that holds them; none while it can't say. */
    useOrclingPicks(enabled: boolean): TeamChatOrclingPick[] {
      const orclings = useQuery(
        { queryKey: ["orclings.list", {}], enabled, retry: false, meta: { tags: tagsFor("orclings.list", {}) }, queryFn: () => ctx.connection.call("orclings.list", {}) },
        ctx.queryClient,
      ).data;
      return useMemo(() => (orclings ?? []).map((orcling) => ({ localOrclingId: orcling.id, name: orcling.name, look: orcling.look })), [orclings]);
    },

    /** The call as its owner reads it: why it couldn't answer, and whether it can be tried again. */
    useOwnerCall(lease: TeamChatLease | null, call: TeamOrclingCall | null, self: string) {
      const enabled = Boolean(lease) && call !== null && call.owner.id === self && (call.state === "failed" || call.state === "uncertain");
      return useQuery(
        {
          queryKey: lease && call ? [...ctx.keys.call(lease, call.id), call.state] : ["team-chat", "unavailable", "call"],
          enabled,
          retry: false,
          meta: { tags: lease ? ctx.tags(lease) : [] },
          queryFn: async ({ signal }) => {
            ctx.current(lease, signal);
            return ctx.connection.call("teamChat.orclingCall", { spaceId: lease!.spaceId, callId: call!.id });
          },
        },
        ctx.queryClient,
      );
    },

    /** The owner tries a failed or uncertain call again; the Mac holding the Orcling runs it. */
    async retryCall(lease: TeamChatLease, target: TeamChatTarget, call: TeamOrclingCall): Promise<void> {
      ctx.live(lease, "You're offline. Reconnect to try again.");
      await ctx.connection.call("teamChat.retryOrclingCall", { spaceId: target.spaceId, conversationId: target.conversationId, callId: call.id });
    },
  };
}
