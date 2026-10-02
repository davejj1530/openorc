import type { OrclingService } from "../services/orclings.js";
import type { Handlers } from "./types.js";

type Dependencies = { orclings: OrclingService };
type OrclingMethod = Extract<keyof Handlers, `orclings.${string}`>;

export function createOrclingHandlers({ orclings }: Dependencies): Pick<Handlers, OrclingMethod> {
  return {
    "orclings.list": () => orclings.list(),
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
  };
}
