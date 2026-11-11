import type { HarnessId } from "@openorc/protocol";

/**
 * Which agents' installations are being replaced right now, and how many times each has been. A launch of an agent
 * waits while its own installation is replaced; every other agent, and every process already running, carries on.
 * Reads take any agent name: one that is never updated is never held.
 */
export class AgentUpdateGate {
  private readonly replacing = new Map<string, Promise<void>>();
  private readonly generations = new Map<string, number>();

  /** Holds launches of `id` until the returned release runs. Releasing again does nothing. */
  begin(id: HarnessId): () => void {
    if (this.replacing.has(id)) throw new Error("This agent is already being updated.");
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.replacing.set(id, settled);
    return () => {
      if (this.replacing.get(id) !== settled) return;
      this.replacing.delete(id);
      this.generations.set(id, this.generation(id) + 1);
      settle();
    };
  }

  /** Resolves when the replacement of `agent` under way ends; null while there is none, so callers add no wait. */
  settled(agent: string): Promise<void> | null {
    return this.replacing.get(agent) ?? null;
  }

  /** Resolves once nothing replaces `agent`, however many replacements follow one another. */
  async idle(agent: string): Promise<void> {
    for (let settled = this.settled(agent); settled; settled = this.settled(agent)) await settled;
  }

  /** Advances each time a replacement of `agent` ends. A process launched under an earlier one may run the old version. */
  generation(agent: string): number {
    return this.generations.get(agent) ?? 0;
  }

  get any(): boolean {
    return this.replacing.size > 0;
  }
}
