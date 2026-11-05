import { APIError, Sandbox as SdkSandbox, Snapshot } from "@vercel/sandbox";
import { STATES, vercelSandboxCost, type VercelCredentials } from "../vercel-sandbox.js";
import { ensureVercelProject, findVercelProject } from "../vercel-projects.js";
import { BRAIN_AWAY_MS, BRAIN_PORT, BRAIN_SANDBOX } from "./layout.js";
import type { BrainAccess, BrainHome, BrainVm } from "./machine.js";
import { billedSnapshots, snapshotStorageCost, type ListedSnapshot } from "./snapshot-storage.js";

/** The sandbox settings a brain needs. Compared on every provision, so brains made before a change get it too. */
export interface BrainSettings {
  ports: number[];
  timeout: number | undefined;
  snapshotExpiration: number | undefined;
  keepLastSnapshots: { count: number; expiration: number | undefined } | undefined;
}

/** A brain never loses its disk to expiry, and keeps one snapshot back for a rollback. */
const SETTINGS: BrainSettings = { ports: [BRAIN_PORT], timeout: BRAIN_AWAY_MS, snapshotExpiration: 0, keepLastSnapshots: { count: 2, expiration: 0 } };

export interface BrainOpenParams extends VercelCredentials {
  name: string;
  persistent: true;
  ports: number[];
  timeout: number;
  snapshotExpiration: number;
  keepLastSnapshots: { count: number; expiration: number };
  resources: { vcpus: number };
  region?: string;
}

/** How a brain machine reaches Vercel. Tests pass a stand-in; everyone else the SDK. */
export interface BrainApi {
  project(token: string, teamId: string, name: string): Promise<{ id: string }>;
  /** The project without making it; null when the team has none. */
  findProject(token: string, teamId: string, name: string): Promise<{ id: string } | null>;
  /** Makes the sandbox when it is missing; either way it runs when this returns. */
  open(params: BrainOpenParams): Promise<BrainVm>;
  /**
   * Null when the sandbox does not exist. Wakes it only when asked to. Its commands run in the session it found, and fail
   * once that stops: asking never wakes a sleeping brain, and a wake that a sleep races resumes again itself.
   */
  get(params: VercelCredentials & { name: string; resume: boolean }): Promise<BrainVm | null>;
  /** The names of every sandbox in the project. */
  list(params: VercelCredentials): Promise<string[]>;
  /** What the project's sandboxes ran from `since` on, one entry per session, as Vercel counts it. Reads only. */
  sessions(params: VercelCredentials & { since: number }): Promise<SessionUsage[]>;
  /** Every snapshot the project's sandboxes made, kept or deleted. Reads only. */
  snapshots(params: VercelCredentials): Promise<ListedSnapshot[]>;
  /** The project's snapshot storage on the team's bill from `since` on, and where the bill ends; null when the token may not read it. */
  billedSnapshots(params: VercelCredentials & { since: number; now: number }): Promise<{ usd: number; until: number } | null>;
  deleteSnapshot(params: VercelCredentials & { id: string }): Promise<void>;
}

/** One session of a sandbox, as Vercel bills it: CPU while it computed, memory for as long as it ran. */
export interface SessionUsage {
  activeCpuMs: number;
  durationMs: number;
  memoryMb: number;
}

/** The part of a session that fell from `since` on: a session running across the start counts its share. */
export function sessionShare(
  session: { startedAt?: number | undefined; createdAt: number; stoppedAt?: number | undefined; duration?: number | undefined; activeCpuDurationMs?: number | undefined; memory: number },
  since: number,
  now: number,
): SessionUsage | null {
  const start = session.startedAt ?? session.createdAt;
  const end = session.stoppedAt ?? (session.duration !== undefined ? start + session.duration : now);
  if (end <= since) return null;
  const durationMs = Math.max(0, end - start);
  const share = durationMs > 0 ? (end - Math.max(start, since)) / durationMs : 1;
  return { activeCpuMs: (session.activeCpuDurationMs ?? 0) * share, durationMs: durationMs * share, memoryMb: session.memory };
}

function brainVm(sandbox: SdkSandbox, resumes: boolean): BrainVm {
  return {
    get cwd() {
      return sandbox.cwd;
    },
    get state() {
      return STATES[sandbox.status];
    },
    get expiresAt() {
      return sandbox.expiresAt;
    },
    get settings() {
      const keep = sandbox.keepLastSnapshots;
      return {
        ports: sandbox.routes.map((route) => route.port),
        timeout: sandbox.timeout,
        snapshotExpiration: sandbox.snapshotExpiration,
        keepLastSnapshots: keep && { count: keep.count, expiration: keep.expiration },
      };
    },
    domain: (port) => (sandbox.routes.some((route) => route.port === port) ? sandbox.domain(port) : null),
    update: (changes) => sandbox.update(changes),
    // The sandbox's own runCommand and writeFiles resume it once stopped, as when it stops between a look and a command.
    runCommand: (params) => (resumes ? sandbox.runCommand(params) : sandbox.currentSession().runCommand(params)),
    writeFiles: (files) => (resumes ? sandbox.writeFiles(files) : sandbox.currentSession().writeFiles(files)),
    readFile: (file) => (resumes ? sandbox.readFileToBuffer({ path: file }) : sandbox.currentSession().readFileToBuffer({ path: file })),
    delete: (options) => sandbox.delete(options),
  };
}

export const vercelSdk: BrainApi = {
  project: ensureVercelProject,
  findProject: findVercelProject,
  open: async (params) => brainVm(await SdkSandbox.getOrCreate({ ...params, resume: true }), true),
  get: async ({ name, resume, token, teamId, projectId }) => {
    try {
      return brainVm(await SdkSandbox.get({ name, resume, token, teamId, projectId }), false);
    } catch (error) {
      if (error instanceof APIError && error.response.status === 404) return null;
      throw error;
    }
  },
  list: async ({ token, teamId, projectId }) => (await (await SdkSandbox.list({ projectId, token, teamId })).toArray()).map((sandbox) => sandbox.name),
  sessions: async ({ token, teamId, projectId, since }) => {
    const used: SessionUsage[] = [];
    const now = Date.now();
    for await (const listed of await SdkSandbox.list({ projectId, token, teamId })) {
      // A sandbox untouched since then ran no session since, unless one still runs from before.
      if (listed.updatedAt < since && listed.status !== "running") continue;
      const sandbox = await SdkSandbox.get({ name: listed.name, resume: false, token, teamId, projectId });
      for await (const session of await sandbox.listSessions({ sortOrder: "desc" })) {
        const share = sessionShare(session, since, now);
        if (!share) break;
        used.push(share);
      }
    }
    return used;
  },
  snapshots: async (credentials) =>
    (await (await Snapshot.list(credentials)).toArray()).map(({ id, parentId, status, sizeBytes, createdAt, expiresAt, lastUsedAt }) => ({
      id,
      parentId,
      status,
      sizeBytes,
      createdAt,
      expiresAt,
      lastUsedAt,
    })),
  deleteSnapshot: async ({ id, ...credentials }) => (await Snapshot.get({ snapshotId: id, ...credentials })).delete(),
  billedSnapshots: async ({ token, teamId, projectId, since, now }) => {
    const range = new URLSearchParams({ teamId, from: new Date(since).toISOString(), to: new Date(now).toISOString() });
    const response = await fetch(`https://api.vercel.com/v1/billing/charges?${range}`, { headers: { authorization: `Bearer ${token}` } });
    return response.ok ? billedSnapshots(await response.text(), projectId, since) : null;
  },
};

function drift(current: BrainSettings): Partial<BrainSettings> {
  const keys = Object.keys(SETTINGS) as (keyof BrainSettings)[];
  return Object.fromEntries(keys.filter((key) => JSON.stringify(current[key]) !== JSON.stringify(SETTINGS[key])).map((key) => [key, SETTINGS[key]]));
}

/** The brain on Vercel: a persistent sandbox in its own project, beside the thread sandboxes it makes there. */
export function vercelHome(access: Extract<BrainAccess, { service: "vercel" }>, api: BrainApi, project: { id: string }): BrainHome {
  const credentials: VercelCredentials = { token: access.token, teamId: access.teamId, projectId: project.id };
  const name = access.sandbox ?? BRAIN_SANDBOX;
  return {
    secrets: [access.token],
    async open({ vcpus, region }) {
      const vm = await api.open({
        ...credentials,
        name,
        persistent: true,
        ports: SETTINGS.ports,
        timeout: BRAIN_AWAY_MS,
        snapshotExpiration: 0,
        keepLastSnapshots: { count: 2, expiration: 0 },
        resources: { vcpus },
        ...(region ? { region } : {}),
      });
      const changes = vm.settings ? drift(vm.settings) : {};
      if (Object.keys(changes).length) await vm.update?.(changes);
      return vm;
    },
    get: (resume) => api.get({ ...credentials, name, resume }),
    launch: (_vm, { threadVcpus }) => ({ vercel: { connection: { ...credentials, ...(threadVcpus ? { vcpus: threadVcpus } : {}) }, sandbox: name } }),
    /** From the sessions Vercel counts, at its list prices, and what the snapshots cost to keep. */
    async costSince(since, now) {
      const [sessions, snapshots, billed] = await Promise.all([
        api.sessions({ ...credentials, since }),
        api.snapshots(credentials),
        api.billedSnapshots({ ...credentials, since, now }).catch(() => null),
      ]);
      const ran = sessions.reduce((sum, session) => sum + vercelSandboxCost({ activeCpuMs: session.activeCpuMs, durationMs: session.durationMs, memoryMb: session.memoryMb }), 0);
      // The days Vercel billed already, as billed; the hours since, from the snapshots it lists.
      return ran + (billed?.usd ?? 0) + snapshotStorageCost(snapshots, Math.max(since, billed?.until ?? since), now);
    },
    /**
     * Every sandbox in the brain's project, with their snapshots. Vercel deletes the snapshots only they used on its own,
     * later, and has left one behind, so any still kept are deleted after.
     */
    async removeAll() {
      const names = await api.list(credentials);
      for (const each of [name, ...names.filter((other) => other !== name)]) {
        const vm = await api.get({ ...credentials, name: each, resume: false });
        await vm?.delete({ deleteOrphanSnapshots: true });
      }
      for (const snapshot of await api.snapshots(credentials)) if (snapshot.status === "created") await api.deleteSnapshot({ ...credentials, id: snapshot.id }).catch(() => undefined);
    },
  };
}
