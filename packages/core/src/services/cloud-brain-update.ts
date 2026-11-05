import { BrainRefused } from "@openorc/cloud";
import type { BrainMachineLike } from "./cloud-brain-machine.js";

/** How long a wake waits for a busy brain to restart onto its update, and how often it asks. */
export interface UpdateWait {
  waitMs: number;
  forMs: number;
}

/**
 * Right after a turn or a failed start the brain is busy for a moment, as while it keeps a sandbox awake, so a wake that
 * found it on an older version asks it to stop for the update again until it says yes or the time is up. False when it
 * stayed busy: it then starts on the new version at its next start. Any other failure may have stopped it.
 */
export async function stopForUpdate(machine: Pick<BrainMachineLike, "control">, wait: UpdateWait): Promise<boolean> {
  const deadline = Date.now() + wait.forMs;
  for (;;) {
    try {
      await machine.control({ op: "stop-for-update" });
      return true;
    } catch (error) {
      if (!(error instanceof BrainRefused)) return true;
      if (Date.now() + wait.waitMs > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, wait.waitMs));
    }
  }
}
