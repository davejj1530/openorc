import { isHarnessId, type HarnessId } from "@openorc/protocol";
import { claudeSlot } from "./claude/session-slot.js";
import { codexSlot } from "./codex/session-slot.js";
import { cursorSlot } from "./cursor/session-slot.js";
import { piSlot } from "./pi/session-slot.js";
import { antigravitySlot } from "./antigravity/session-slot.js";
import { fxSlot } from "./fx/session-slot.js";
import { ompSlot } from "./omp/session-slot.js";
import { openCodeSlot } from "./opencode/session-slot.js";
import type { SessionSlot } from "./session-slot.js";

/** Total over HarnessId: a new harness fails the build until it has a slot. */
export const sessionSlots: { readonly [A in HarnessId]: SessionSlot & { readonly agent: A } } = {
  claude: claudeSlot,
  codex: codexSlot,
  opencode: openCodeSlot,
  omp: ompSlot,
  cursor: cursorSlot,
  pi: piSlot,
  antigravity: antigravitySlot,
  fx: fxSlot,
};

/** The slot of a thread's agent; null for an agent kind with no adapter, whose conversations stay where they are. */
export function slotFor(agent: string): SessionSlot | null {
  return isHarnessId(agent) ? sessionSlots[agent] : null;
}
