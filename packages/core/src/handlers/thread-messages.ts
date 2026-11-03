import { Db, threads } from "@openorc/db";
import { ThreadService } from "../services/threads.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  db: Db;
  threadService: Pick<ThreadService, "compact" | "queue" | "unqueue" | "sendQueued" | "stopCommand" | "send">;
};

export function createThreadMessagesHandlers({
  db,
  threadService,
}: Dependencies): Pick<Handlers, "threads.compact" | "threads.queue" | "threads.unqueue" | "threads.sendQueued" | "threads.stopCommand" | "threads.send"> {
  return {
    "threads.compact": async ({ id }) => {
      await threadService.compact(id);
      return null;
    },
    "threads.queue": ({ id, text, attachments, requestKey }) => threadService.queue(id, text, attachments, requestKey),
    "threads.unqueue": ({ id, messageId }) => threadService.unqueue(id, messageId),
    "threads.sendQueued": ({ id, messageId }) => threadService.sendQueued(id, messageId),
    "threads.stopCommand": async ({ id, commandId }) => {
      await threadService.stopCommand(id, commandId);
      return null;
    },
    "threads.send": async ({ id, text, fromThreadId }) => {
      await threadService.send(id, text, fromThreadId ? threads.get(db, fromThreadId) : null);
      return null;
    },
  };
}
