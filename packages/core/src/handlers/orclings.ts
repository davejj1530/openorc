import { lastThreadMessage, type Db, type LedgerWriter } from "@openorc/db";
import type { OrclingService } from "../services/orclings.js";
import type { ThreadService } from "../services/threads.js";
import { PREVIEW_CHARS } from "./thread-queries.js";
import type { Handlers } from "./types.js";

type Dependencies = { orclings: OrclingService; threads: Pick<ThreadService, "get">; db: Db; ledger: Pick<LedgerWriter, "flush"> };
type OrclingMethod = Extract<keyof Handlers, `orclings.${string}`>;

export function createOrclingHandlers({ orclings, threads, db, ledger }: Dependencies): Pick<Handlers, OrclingMethod> {
  return {
    "orclings.list": () => orclings.list(),
    "orclings.chats": () => {
      // A message sent a moment ago can still be waiting for the ledger's next write.
      ledger.flush();
      return orclings.list().map(({ id, name, look, threadId }) => ({ id, name, look, threadId, thread: threads.get(threadId), last: lastThreadMessage(db, threadId, PREVIEW_CHARS) }));
    },
    "orclings.profile": ({ id }) => {
      const { name, look, settings, permission, claudeAccountId, wakes } = orclings.get(id);
      const memories = orclings.memories(id).map(({ id: memoryId, title, body, updatedAt }) => ({ id: memoryId, title, body, updatedAt }));
      return { id, name, look, settings, permission, claudeAccountId, wakes, instructions: orclings.instructions(id)[0]?.body ?? null, memories };
    },
    "orclings.create": ({ draft }) => orclings.create(draft),
    "orclings.update": ({ id, draft }) => orclings.update(id, draft),
    "orclings.delete": async ({ id }) => {
      await orclings.delete(id);
      return null;
    },
    "orclings.instructions": ({ id }) => orclings.instructions(id),
    "orclings.instructions.save": ({ id, body }) => orclings.saveInstructions(id, body, "user", null),
    "orclings.instructions.restore": ({ id, version }) => orclings.restoreInstructions(id, version),
    "orclings.memories": ({ id }) => orclings.memories(id),
    "orclings.ask": ({ id, threadId, prompt, attachments }) => orclings.ask(id, threadId, prompt, attachments),
    "orclings.assign": ({ threadId, orclingId }) => {
      orclings.assign(threadId, orclingId);
      return null;
    },
    "orclings.wakes.save": ({ id, wakes }) => orclings.saveWakes(id, wakes),
    "orclings.reactions": ({ threadId }) => orclings.reactions(threadId),
    "orclings.react": ({ threadId, runId, messageId, part, reaction }) => {
      orclings.react({ threadId, runId, messageId, part }, reaction, null);
      return null;
    },
    "orclings.origins": ({ threadId }) => orclings.talk.origins(threadId),
    "orclings.groups.list": () => orclings.talk.groupsList(),
    "orclings.groups.create": ({ memberIds, title }) => orclings.talk.createGroup(memberIds, title, null),
    "orclings.groups.send": async ({ threadId, text, attachments, messageId }) => {
      await orclings.talk.sendToGroup(threadId, text, { ...(messageId ? { messageId } : {}), ...(attachments?.length ? { attachments } : {}) });
      return null;
    },
    "orclings.groups.delete": ({ threadId }) => {
      orclings.talk.deleteGroup(threadId);
      return null;
    },
  };
}
