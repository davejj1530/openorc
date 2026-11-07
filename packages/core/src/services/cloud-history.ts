import { fillHistory, type Sandbox, type WorkspaceLocation } from "@openorc/cloud";
import type { Logger } from "../transport.js";
import { Phases } from "./cloud-phases.js";

/**
 * Brings the history of checkouts seeded with their commit alone, in the background: one fill at a time per sandbox, so
 * a second ask waits for the first and finds nothing left to send. One that failed is tried again at the next turn.
 */
export class CloudHistory {
  private readonly filling = new WeakMap<Sandbox, Promise<void>>();
  private readonly failed = new WeakSet<Sandbox>();

  constructor(private readonly log: Logger) {}

  /** `source` is the repository holding the commits, which a worktree still being made cannot be yet. */
  fill(location: WorkspaceLocation, source: string): void {
    const { sandbox } = location.install;
    const phases = new Phases();
    const next = (this.filling.get(sandbox) ?? Promise.resolve())
      .then(() => phases.time("history", () => fillHistory(location, source)))
      .then(
        (sent) => {
          this.failed.delete(sandbox);
          if (sent) this.log.info(phases.line(`cloud workspace ${sandbox.name} got its history`));
        },
        (error: unknown) => {
          this.failed.add(sandbox);
          this.log.warn(`cloud workspace ${sandbox.name} could not get its history, so git log there stops at its first commit: ${error instanceof Error ? error.message : String(error)}`);
        },
      );
    this.filling.set(sandbox, next);
  }

  /** Tries again where the last fill failed, as when the VM stopped while the history went up. */
  again(location: WorkspaceLocation): void {
    if (this.failed.has(location.install.sandbox)) this.fill(location, location.mirror);
  }
}
