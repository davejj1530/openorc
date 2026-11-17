import type { TeamChatStatus } from "@openorc/protocol";
import { teamChatRoster, type TeamChatRow } from "./team-chat.js";
import { teamChatContext, type TeamChatDeps } from "./team-chat-context.js";
import { teamChatOrganizationReads, teamChatReads } from "./team-chat-reads.js";
import { teamChatWrites } from "./team-chat-writes.js";

export type { TeamChatDeps, TeamChatLease } from "./team-chat-context.js";

/** A row of the conversation list: a person, a group or a channel, with what is unread in it. */
export type TeamChatListRow = TeamChatRow & { unread: number; mentioned: boolean };

/** The conversation list, people first, with each conversation's unread count and whether it tags the person. */
export function teamChatList(state: TeamChatStatus | undefined, self: string): TeamChatListRow[] {
  if (state?.state !== "ready") return [];
  return teamChatRoster(state.chat, self).map((row) => {
    const read = row.conversation?.joined ? row.conversation.read : null;
    return { ...row, unread: read?.unread ?? 0, mentioned: read?.hasMention ?? false };
  });
}

/**
 * Team chat below the screens, for the desktop's windows and the phone alike: every read is keyed by the lease it was
 * read under and refreshed by the chat's own invalidations, every write goes to the connection, and drafts and
 * unconfirmed sends outlive a launch in the app's own storage.
 */
export function createTeamChat(deps: TeamChatDeps) {
  const ctx = teamChatContext(deps);
  return { drafts: ctx.drafts, keys: ctx.keys, receive: ctx.receive, storeRead: ctx.storeRead, ...teamChatReads(ctx), ...teamChatOrganizationReads(ctx), ...teamChatWrites(ctx) };
}

export type TeamChatStore = ReturnType<typeof createTeamChat>;
