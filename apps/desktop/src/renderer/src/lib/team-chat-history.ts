import { mergeTeamMessages } from "@openorc/client";
import type { TeamChatTimeline } from "@openorc/protocol";

/** Refresh the visible page and fill missed sequences before publishing one reconciled history. */
export async function refreshTeamHistory(prior: TeamChatTimeline | undefined, read: (afterSeq?: number) => Promise<TeamChatTimeline>): Promise<TeamChatTimeline> {
  const latest = await read();
  if (!prior) return latest;
  let cursor = prior.headSeq;
  let messages = prior.messages;
  while (cursor < (latest.messages[0]?.seq ?? 0) - 1) {
    const page = await read(cursor);
    const next = page.messages.at(-1)?.seq ?? cursor;
    if (next <= cursor) throw new Error("Messages couldn't be refreshed. Try again.");
    messages = mergeTeamMessages(messages, page.messages);
    cursor = next;
    if (!page.newer) break;
  }
  return { ...latest, older: prior.older, messages: mergeTeamMessages(messages, latest.messages) };
}
