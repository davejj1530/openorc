import type { TeamChatPerson } from "@openorc/protocol";
import { userOf } from "./stand-in-spaces.js";
import type { StandInChatRecord } from "./stand-in-chat.js";

type Reply = { status: number; body: unknown };

/** Pins as the server keeps them: anyone in the conversation pins for everyone; readers who haven't joined only look. */
export const standInPins = {
  list(record: StandInChatRecord): Reply {
    const pinned = record.messages.filter((message) => message.pinned).sort((a, b) => b.pinned!.at.localeCompare(a.pinned!.at));
    return { status: 200, body: { pins: pinned.map((message) => ({ message, pinnedBy: message.pinned!.by, pinnedAt: message.pinned!.at })) } };
  },

  change(record: StandInChatRecord, who: string, person: TeamChatPerson, messageId: string, pin: boolean): Reply {
    const message = record.messages.find((candidate) => candidate.id === messageId);
    if (!message) return { status: 404, body: { message: "That message isn't here." } };
    if (!record.conversation.members.some((member) => member.id === userOf(who)))
      return { status: 403, body: { message: `Join #${record.conversation.name ?? "this conversation"} to pin its messages.` } };
    if (pin && !message.pinned) message.pinned = { by: person, at: new Date().toISOString() };
    if (!pin) message.pinned = null;
    return { status: 200, body: message };
  },
};
