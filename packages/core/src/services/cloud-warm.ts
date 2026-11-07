import { randomUUID } from "node:crypto";
import { SANDBOX_PREFIX, seedFromCommit, writeBaseMarker, type RunnerClient, type SandboxProvider } from "@openorc/cloud";
import { settings, type CloudProviderId, type Db } from "@openorc/db";
import { git, originUrl } from "@openorc/git";
import type { HarnessId, Project } from "@openorc/protocol";
import type { Logger } from "../transport.js";
import { runSetupScript, setupHash, type CloudBase, type CloudBases } from "./cloud-bases.js";
import { cloudSetup, installDependencies, setupText } from "./cloud-deps.js";
import type { CloudHistory } from "./cloud-history.js";
import type { CloudLocation } from "./cloud-workspaces.js";
import { usesDocker } from "./uses-docker.js";

/** A sandbox made ahead for the next cloud conversation in a project, while its first message is being written. */
export interface Warmed {
  project: string;
  provider: CloudProviderId;
  docker: boolean;
  name: string;
  /** Open, its runner and the conversation's agent in place, and connected; null once that failed. */
  ready: Promise<{ location: CloudLocation; client: RunnerClient } | null>;
}

/** How long a sandbox made ahead waits for its conversation after the last keystroke asked for it. */
const WARM_MS = 5 * 60_000;
/** The sandboxes made ahead, by name, so those left when OpenOrc closed are deleted when it opens. */
const SETTING = "cloud.warm";

export interface CloudWarmDeps {
  db: Db;
  /** Where new cloud conversations run now. */
  provider: () => Promise<SandboxProvider>;
  bases?: CloudBases | undefined;
  open: (name: string, provider: CloudProviderId, mirror: string, from: CloudBase | undefined) => Promise<CloudLocation>;
  /** Without a base: the project's code at its checked-out branch and its setup, as a base would hold them. */
  prepare: (location: CloudLocation, project: Project) => Promise<CloudLocation>;
  agent: (agent: HarnessId, location: CloudLocation, provider: CloudProviderId) => Promise<void>;
  connect: (name: string, location: CloudLocation) => Promise<RunnerClient>;
  remove: (provider: CloudProviderId, name: string) => Promise<void>;
  log: Logger;
}

/**
 * Sandboxes made ahead: while a cloud conversation's first message is written, its sandbox opens from its project's
 * base, gets its agent and connects, so sending starts the conversation in seconds. One per project and service; one
 * nobody takes is deleted five minutes after the last keystroke asked for it.
 */
export class CloudWarm {
  private readonly made = new Map<string, Warmed & { expires: NodeJS.Timeout }>();
  private swept: Promise<void> | null = null;

  constructor(private readonly deps: CloudWarmDeps) {}

  /** Makes a sandbox ahead for a new conversation in `project` with `agent`, or keeps the one made waiting longer. */
  async warm(project: Project, agent: HarnessId): Promise<void> {
    this.swept ??= this.sweep().catch((error: unknown) => this.deps.log.warn(`could not delete the cloud sandboxes made ahead before: ${words(error)}`));
    const service = await this.deps.provider();
    const key = `${project.id}:${service.id}`;
    const existing = this.made.get(key);
    if (existing) {
      existing.expires.refresh();
      return;
    }
    const head = (await git(project.rootPath, ["rev-parse", "HEAD"], { okCodes: [0, 128] })).stdout.trim() || undefined;
    const docker = await usesDocker(project.rootPath, head).catch(() => false);
    const from = (await this.deps.bases?.usable(project, service.id, docker).catch(() => null)) ?? undefined;
    // The first conversations of a project start without a base; this one asks for it to be made.
    this.deps.bases?.refresh(project, service.id, docker);
    const name = `${SANDBOX_PREFIX}${randomUUID()}`;
    this.remember(name, service.id, true);
    const ready = (async () => {
      const opened = await this.deps.open(name, service.id, project.rootPath, from);
      // The agent installs while the code goes up and the setup runs; both end before the sandbox counts as made, so a
      // failure in one never leaves the other writing into a sandbox about to be deleted.
      const [prepared, installed] = await Promise.allSettled([opened.base ? opened : this.deps.prepare(opened, project), this.deps.agent(agent, opened, service.id)]);
      if (prepared.status === "rejected") throw prepared.reason;
      if (installed.status === "rejected") throw installed.reason;
      const location = prepared.value;
      return { location, client: await this.deps.connect(name, location) };
    })().catch((error: unknown) => {
      this.deps.log.warn(`could not make a cloud sandbox ahead for project ${project.name}: ${words(error)}`);
      return null;
    });
    const expires = setTimeout(() => void this.expire(key), WARM_MS);
    expires.unref();
    this.made.set(key, { project: project.id, provider: service.id, docker, name, ready, expires });
    this.deps.log.info(`cloud sandbox ${name} being made ahead for project ${project.name}${from ? " from its base" : ""}`);
  }

  /** The sandbox made ahead for a new conversation in `project` on `provider`, which it takes: no other will. */
  take(project: Project, provider: CloudProviderId, docker: boolean): Warmed | null {
    const key = `${project.id}:${provider}`;
    const entry = this.made.get(key);
    if (!entry || entry.docker !== docker) return null;
    clearTimeout(entry.expires);
    this.made.delete(key);
    this.remember(entry.name, provider, false);
    return entry;
  }

  /** Deletes every sandbox made ahead that no conversation took, as OpenOrc closes. */
  async close(): Promise<void> {
    await Promise.all([...this.made.keys()].map((key) => this.expire(key)));
  }

  private async expire(key: string): Promise<void> {
    const entry = this.made.get(key);
    if (!entry) return;
    clearTimeout(entry.expires);
    this.made.delete(key);
    (await entry.ready)?.client.close();
    await this.deps.remove(entry.provider, entry.name).then(
      () => this.remember(entry.name, entry.provider, false),
      (error: unknown) => this.deps.log.warn(`could not delete cloud sandbox ${entry.name}, made ahead and never used: ${words(error)}`),
    );
  }

  private remember(name: string, provider: CloudProviderId, kept: boolean): void {
    const others = this.left().filter((each) => each.name !== name);
    settings.set(this.deps.db, SETTING, JSON.stringify(kept ? [...others, { name, provider }] : others));
  }

  private left(): { name: string; provider: CloudProviderId }[] {
    const raw = settings.get(this.deps.db, SETTING);
    return raw ? (JSON.parse(raw) as { name: string; provider: CloudProviderId }[]) : [];
  }

  /** Deletes the sandboxes made ahead before OpenOrc last closed, which no conversation took. */
  private async sweep(): Promise<void> {
    const mine = new Set([...this.made.values()].map((entry) => entry.name));
    for (const { name, provider } of this.left().filter((each) => !mine.has(each.name))) {
      await this.deps.remove(provider, name);
      this.remember(name, provider, false);
    }
  }
}

const words = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface PrepareAheadDeps {
  history: CloudHistory;
  dockerUp: (location: CloudLocation) => Promise<void>;
  projectEnv: (projectId: string) => Promise<Record<string, string>>;
}

/**
 * A sandbox made ahead without a base gets what a base would hold: the project's checked-out branch, its commit first
 * and its history after, and its setup, marked as a base's are, so the conversation that takes it brings only what
 * changed since.
 */
export async function prepareAhead(location: CloudLocation, project: Project, deps: PrepareAheadDeps): Promise<CloudLocation> {
  const source = project.rootPath;
  const branch = (await git(source, ["symbolic-ref", "-q", "--short", "HEAD"], { okCodes: [0, 1] })).stdout.trim();
  if (!branch) return location;
  const commit = (await git(source, ["rev-parse", `refs/heads/${branch}^{commit}`])).stdout.trim();
  const origin = (await originUrl(source)) ?? undefined;
  await seedFromCommit(location, { source, commit, branch, ...(origin ? { origin } : {}) });
  deps.history.fill(location, source);
  const setup = await cloudSetup(project, source, commit);
  if (setup?.kind === "script") {
    await deps.dockerUp(location);
    await runSetupScript(location, setup.script, project.name, await deps.projectEnv(project.id));
  } else if (setup) await installDependencies(location.install, location.repo, setup.command, await deps.projectEnv(project.id), false);
  const base = { commit, branch, setup: setupHash(setupText(setup)), agents: {}, shallow: true };
  await writeBaseMarker(location.install, base);
  return { ...location, base };
}
