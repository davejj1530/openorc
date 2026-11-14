import { CHAT_STRETCH_MS } from "@openorc/client";
import type { TeamMessage } from "@openorc/protocol";

export type TeamChatGroup = { kind: "time"; id: string; at: number } | { kind: "messages"; id: string; messages: TeamMessage[] };

/** Whole human messages group by speaker, with the same stretch breaks as companion chat. */
export function teamChatGroups(messages: readonly TeamMessage[]): TeamChatGroup[] {
  const groups: TeamChatGroup[] = [];
  let previousAt: number | null = null;
  for (const message of messages) {
    const at = Date.parse(message.createdAt);
    if (previousAt === null || at - previousAt >= CHAT_STRETCH_MS) groups.push({ kind: "time", id: `time:${message.id}`, at });
    const last = groups.at(-1);
    if (last?.kind === "messages" && last.messages[0]?.actor.person?.id === message.actor.person?.id) last.messages.push(message);
    else groups.push({ kind: "messages", id: message.id, messages: [message] });
    previousAt = at;
  }
  return groups;
}
