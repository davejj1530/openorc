import { Db, orchestration, teamDeletedThreads, threads } from "@openorc/db";
import { randomUUID } from "node:crypto";
import { TeamConversationService } from "../services/team-conversation.js";
import { ThreadService } from "../services/threads.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  db: Db;
  teamConversations: Pick<TeamConversationService, "compact" | "relay" | "send">;
  threadService: Pick<ThreadService, "compact" | "queue" | "unqueue" | "sendQueued" | "send">;
};

export function createThreadMessagesHandlers({
  db,
  teamConversations,
  threadService,
}: Dependencies): Pick<Handlers, "threads.compact" | "threads.queue" | "threads.unqueue" | "threads.sendQueued" | "threads.send"> {
  return {
    "threads.compact": async ({ id, requestKey }) => {
      if (orchestration.getInstance(db, id)) {
        if (!requestKey) throw new Error("Compacting a team requires a durable request key. Use the team conversation control.");
        teamConversations.compact({ threadId: id, requestKey });
      } else await threadService.compact(id);
      return null;
    },
    "threads.queue": ({ id, text, attachments, requestKey }) => threadService.queue(id, text, attachments, requestKey),
    "threads.unqueue": ({ id, messageId }) => threadService.unqueue(id, messageId),
    "threads.sendQueued": ({ id, messageId }) => threadService.sendQueued(id, messageId),
    "threads.send": async ({ id, text, fromThreadId }) => {
      if (orchestration.getInstance(db, id)) {
        if (fromThreadId) {
          const from = threads.get(db, fromThreadId);
          if (!from || teamDeletedThreads.has(db, from.id)) throw new Error("The source thread was not found.");
          teamConversations.relay({ threadId: id, text, requestKey: randomUUID(), source: { threadId: from.id, title: from.title } });
          return null;
        }
        await teamConversations.send({ threadId: id, text, requestKey: randomUUID() });
        return null;
      }
      await threadService.send(id, text, fromThreadId ? threads.get(db, fromThreadId) : null);
      return null;
    },
  };
}
