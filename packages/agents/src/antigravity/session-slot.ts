import { SessionRefused, partsDigest, versionReader, type SessionSlot } from "../session-slot.js";

const reason = "Antigravity conversations stay on the computer where they started. Cloud execution and session transfer are not supported yet.";
const refuse = (): never => {
  throw new SessionRefused(reason);
};

export const antigravitySlot = {
  agent: "antigravity",
  format: 1,
  stays: reason,
  version: versionReader(),
  readable: (written, reader) => written === reader,
  export: refuse,
  import: refuse,
  check: async () => reason,
  digest: (saved) => partsDigest(saved.parts),
  continueOnce: refuse,
} satisfies SessionSlot;
