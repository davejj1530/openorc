import { BRAIN_PROJECT, ensureVercelProject, signInPrint, type Agent37Connection, type BrainSelf, type BrainStart, type HandoverValues, type VercelConnection } from "@openorc/cloud";
import type { ProtectedSecretStore } from "@openorc/core";
import type { CloudService } from "@openorc/protocol";

type Handed = HandoverValues["cloud"];

/** Its sealed file's channel: the brain's own, beside the core's (secrets.ts), which keep no cloud connection here. */
export const CLOUD_CHANNEL = "cloud";

export interface BrainCloudDeps {
  store: ProtectedSecretStore;
  start: BrainStart;
  /** The brain's own machine: thread sandboxes on Vercel go in its region unless the Mac names one. */
  self: Pick<BrainSelf, "region">;
  /** Finds or makes a team's project by name; Vercel's own API unless given. */
  project?: (token: string, teamId: string, name: string) => Promise<{ id: string }>;
  warn(text: string): void;
}

/**
 * Where the brain's new threads run and the connections its thread machines are made with: as its Mac's Settings says
 * once the Mac handed that over, sealed on the brain's disk so a restart or a door's wake keeps it; before, as the
 * start line says, on the service the brain lives on. The core asks at each use, so a change reaches the next thread.
 */
export class BrainCloud {
  private handed: Handed | null = null;
  /** The brain's own project on a team its start line does not name, by team and token. */
  private readonly projects = new Map<string, Promise<string>>();

  constructor(private readonly deps: BrainCloudDeps) {}

  /** At start. One that cannot be read is gone, so threads run where the brain lives until the Mac sends it again. */
  async load(): Promise<void> {
    try {
      const saved = await this.deps.store.load();
      this.handed = saved ? (JSON.parse(saved) as Handed) : null;
    } catch {
      this.handed = null;
      this.deps.warn("Where new threads run could not be read, so they run where the brain lives until the Mac sends it again.");
    }
  }

  async take(value: Handed): Promise<void> {
    await this.deps.store.save(JSON.stringify(value));
    this.handed = value;
  }

  /** Names the one it holds, as the Mac names the one it sent; null before any. */
  print(): string | null {
    return this.handed && signInPrint(this.handed);
  }

  async service(): Promise<CloudService | null> {
    if (this.handed) return this.handed.service;
    const { agent37, vercel } = this.deps.start;
    if (agent37) return "agent37";
    return vercel ? "vercel" : null;
  }

  async agent37(): Promise<Agent37Connection | null> {
    return this.handed ? this.handed.agent37 : (this.deps.start.agent37?.connection ?? null);
  }

  /** In the brain's own project: the one its start line names on that team, else one it finds or makes there. */
  async vercel(): Promise<VercelConnection | null> {
    const own = this.deps.start.vercel?.connection ?? null;
    if (!this.handed) return own && { ...own, region: await this.deps.self.region() };
    const vercel = this.handed.vercel;
    if (!vercel) return null;
    const projectId = own?.teamId === vercel.teamId ? own.projectId : await this.projectOn(vercel.token, vercel.teamId);
    const region = vercel.region ?? (own ? await this.deps.self.region() : undefined);
    return { ...vercel, projectId, ...(region ? { region } : {}) };
  }

  private projectOn(token: string, teamId: string): Promise<string> {
    const key = `${teamId}\n${token}`;
    const found =
      this.projects.get(key) ??
      (this.deps.project ?? ensureVercelProject)(token, teamId, BRAIN_PROJECT).then(
        (project) => project.id,
        (error: unknown) => {
          this.projects.delete(key);
          throw error;
        },
      );
    this.projects.set(key, found);
    return found;
  }
}
