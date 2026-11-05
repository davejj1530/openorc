import { isHarnessId, type HarnessId } from "@openorc/protocol";
import { claudeSlot } from "./claude/session-slot.js";
import { codexSlot } from "./codex/session-slot.js";
import { openCodeSlot } from "./opencode/session-slot.js";
import type { SessionSlot } from "./session-slot.js";

/** Total over HarnessId: a new harness fails the build until it has a slot. */
export const sessionSlots: { readonly [A in HarnessId]: SessionSlot & { readonly agent: A } } = { claude: claudeSlot, codex: codexSlot, opencode: openCodeSlot };

/** The slot of a thread's agent; null for an agent kind with no adapter, whose conversations stay where they are. */
export function slotFor(agent: string): SessionSlot | null {
  return isHarnessId(agent) ? sessionSlots[agent] : null;
}
