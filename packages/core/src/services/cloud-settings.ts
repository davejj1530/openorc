import { Agent37Error, agent37Api, type Agent37Api, type Agent37Connection, type VercelConnection } from "@openorc/cloud";
import { AGENT37_SIZES, brainRegionFor, type Agent37Size, type BrainRegion, type CloudService, type CloudStatus, type CloudTeam } from "@openorc/protocol";
import type { ProtectedSecretStore } from "./extraction-credentials.js";

/** The project on the chosen team that cloud threads' sandboxes belong to. */
export const SANDBOX_PROJECT = "openorc-sandboxes";
const API = "https://api.vercel.com";
const storageError = "Cannot access protected storage for cloud credentials. Unlock your OS keychain and retry.";

/** What a token reaches, by Vercel's word: the whole account, these teams, or null when Vercel would not say. */
type Reach = "account" | string[] | null;

interface Stored {
  /** `reach` is missing until Vercel was asked; records from before lack it. */
  vercel?: { token: string; team?: CloudTeam; project?: { id: string; name: string }; vcpus?: number; region?: BrainRegion; reach?: Reach };
  agent37?: { key: string; size?: Agent37Size };
  /** The service chosen for new cloud threads; the connected one when only one is. */
  service?: CloudService;
  /** Working conversations move to the cloud when this Mac goes to sleep. */
  takeover?: boolean;
}

/** The part of what Settings shows that this keeps. */
export type VercelStatus = Pick<CloudStatus, "vercel" | "agent37" | "service" | "error" | "takeover">;

/** New Agent37 instances' size until another is chosen: the smallest. */
const AGENT37_SIZE = AGENT37_SIZES[0];

/** The service new cloud threads run on: the one chosen while it stays connected, else Vercel's, else Agent37's. */
function serviceOf(stored: Stored): CloudService | null {
  const connected = { vercel: Boolean(stored.vercel?.team && stored.vercel.project), agent37: Boolean(stored.agent37) };
  if (stored.service && connected[stored.service]) return stored.service;
  if (connected.vercel) return "vercel";
  return connected.agent37 ? "agent37" : null;
}

export type VercelRequest = (url: string, init: RequestInit) => Promise<Response>;

export interface CloudSettingsOptions {
  request?: VercelRequest;
  /** How a key reaches Agent37; tests pass a stand-in. */
  agent37?: (key: string) => Pick<Agent37Api, "list">;
  /** The cloud brain's region, null without one. Unless another is chosen, this Mac's sandboxes run beside it. */
  brainRegion?: () => Promise<BrainRegion | null>;
  /** This Mac's time zone, an IANA name, which picks the region when nothing else does. */
  timeZone?: () => string;
}

/** Whether the token reaches more than the chosen team, by Vercel's word; nothing before a team is chosen. */
function reachesMore({ reach, team }: NonNullable<Stored["vercel"]>): boolean {
  return Boolean(team && reach && (reach === "account" || reach.some((id) => id !== team.id)));
}

/** Vercel's own words about a refusal; never the request, which carries the token. */
async function refusal(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: { message?: unknown } } | null;
  return typeof body?.error?.message === "string" ? body.error.message : `Vercel answered ${response.status}.`;
}

/**
 * Where cloud threads run: a Vercel token with the team and project its sandboxes use. Kept only in main's protected
 * store, read and written one operation at a time. How each Claude account signs in there is `ClaudeCloudTokens`.
 */
export class CloudSettings {
  private pending: Promise<unknown> = Promise.resolve();
  private cache: Stored | null = null;
  private readonly request: VercelRequest;
  private readonly agent37Api: (key: string) => Pick<Agent37Api, "list">;
  private readonly brainRegion: () => Promise<BrainRegion | null>;
  private readonly timeZone: () => string;
  /** The token Vercel was last asked about, so one it could not answer for is asked again only at the next start. */
  private reachAskedFor: string | null = null;

  constructor(
    private readonly store: ProtectedSecretStore | undefined,
    options: CloudSettingsOptions = {},
  ) {
    this.request = options.request ?? ((url, init) => fetch(url, init));
    this.agent37Api = options.agent37 ?? ((key) => agent37Api(key));
    this.brainRegion = options.brainRegion ?? (async () => null);
    this.timeZone = options.timeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  }

  /** Where new sandboxes run: the region chosen, else the cloud brain's, else the nearest by this Mac's time zone. */
  private async region(vercel: NonNullable<Stored["vercel"]>): Promise<BrainRegion> {
    return vercel.region ?? (await this.brainRegion()) ?? brainRegionFor(this.timeZone());
  }

  private async view(stored: Stored): Promise<VercelStatus> {
    const vercel = stored.vercel;
    return {
      vercel: vercel
        ? { team: vercel.team ?? null, project: vercel.project?.name ?? null, vcpus: vercel.vcpus ?? null, region: await this.region(vercel), ...(reachesMore(vercel) ? { reachesMore: true } : {}) }
        : null,
      agent37: stored.agent37 ? { size: stored.agent37.size ?? AGENT37_SIZE } : null,
      service: serviceOf(stored),
      error: null,
      takeover: stored.takeover ?? false,
    };
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation, operation);
    this.pending = next.catch(() => {});
    return next;
  }

  private async read(): Promise<Stored> {
    if (this.cache) return this.cache;
    if (!this.store) return {};
    let raw: string | null;
    try {
      raw = await this.store.load();
    } catch {
      throw new Error(storageError);
    }
    this.cache = raw ? (JSON.parse(raw) as Stored) : {};
    return this.cache;
  }

  private async write(next: Stored): Promise<VercelStatus> {
    try {
      if (!this.store) throw new Error(storageError);
      await this.store.save(JSON.stringify(next));
    } catch {
      throw new Error(storageError);
    }
    this.cache = next;
    return this.view(next);
  }

  private async call<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ response: Response; body: T | null }> {
    const response = await this.request(`${API}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
    return { response, body: response.ok ? ((await response.json()) as T) : null };
  }

  /** Undefined when Vercel could not be asked, so it is asked again later. */
  private async reachOf(token: string): Promise<Reach | undefined> {
    try {
      const { response, body } = await this.call<{ token?: { scopes?: { type?: string; teamId?: string }[] } }>(token, "/v5/user/tokens/current");
      if (!body) return [401, 403, 404].includes(response.status) ? null : undefined;
      const scopes = body.token?.scopes ?? [];
      // A token with no scope at all has no limit, as the Vercel CLI's own login does.
      if (!scopes.length || scopes.some((scope) => scope.type === "user")) return "account";
      const teams = scopes.flatMap((scope) => (scope.type === "team" && scope.teamId ? [scope.teamId] : []));
      return teams.length ? teams : null;
    } catch {
      return undefined;
    }
  }

  private async teamsFor(token: string): Promise<CloudTeam[]> {
    const { response, body } = await this.call<{ teams: { id: string; name: string | null; slug: string }[] }>(token, "/v2/teams?limit=100");
    if (response.status === 401 || response.status === 403) throw new Error("Vercel did not accept that token.");
    if (!body) throw new Error(await refusal(response));
    return body.teams.map((team) => ({ id: team.id, name: team.name || team.slug }));
  }

  /** The team's sandbox project, made the first time. */
  private async projectOn(token: string, team: CloudTeam): Promise<{ id: string; name: string }> {
    const query = `?teamId=${encodeURIComponent(team.id)}`;
    const found = await this.call<{ id: string; name: string }>(token, `/v9/projects/${SANDBOX_PROJECT}${query}`);
    if (found.body) return { id: found.body.id, name: found.body.name };
    if (found.response.status !== 404) throw new Error(await refusal(found.response));
    const made = await this.call<{ id: string; name: string }>(token, `/v11/projects${query}`, { method: "POST", body: { name: SANDBOX_PROJECT } });
    if (!made.body) throw new Error(`Could not make the ${SANDBOX_PROJECT} project on ${team.name}: ${await refusal(made.response)}`);
    return { id: made.body.id, name: made.body.name };
  }

  status(): Promise<VercelStatus> {
    return this.serialize(async () => {
      try {
        return await this.view(await this.withReach(await this.read()));
      } catch (error) {
        return { vercel: null, agent37: null, service: null, error: error instanceof Error ? error.message : storageError, takeover: false };
      }
    });
  }

  /** What a Vercel sandbox needs, or null until Vercel is connected and a team is chosen. */
  credentials(): Promise<VercelConnection | null> {
    return this.serialize(async () => {
      const vercel = (await this.read().catch(() => ({}) as Stored)).vercel;
      if (!vercel?.team || !vercel.project) return null;
      return { token: vercel.token, teamId: vercel.team.id, projectId: vercel.project.id, region: await this.region(vercel), ...(vercel.vcpus ? { vcpus: vercel.vcpus } : {}) };
    });
  }

  /** What an Agent37 instance needs, or null until a key is saved. */
  agent37(): Promise<Agent37Connection | null> {
    return this.serialize(async () => {
      const agent37 = (await this.read().catch(() => ({}) as Stored)).agent37;
      if (!agent37) return null;
      const { cpu, memory } = agent37.size ?? AGENT37_SIZE;
      return { key: agent37.key, cpu, memory };
    });
  }

  /** The service new cloud threads run on, among those connected; null with none. */
  service(): Promise<CloudService | null> {
    return this.serialize(async () => serviceOf(await this.read().catch(() => ({}) as Stored)));
  }

  /** Saves a key Agent37 accepts. */
  connectAgent37(key: string): Promise<VercelStatus> {
    return this.serialize(async () => {
      try {
        await this.agent37Api(key).list();
      } catch (error) {
        if (error instanceof Agent37Error && (error.status === 401 || error.status === 403)) throw new Error("Agent37 did not accept that key.");
        throw error;
      }
      const stored = await this.read();
      return this.write({ ...stored, agent37: { key } });
    });
  }

  /** The size of instances made from now on. One that exists keeps its size. */
  chooseAgent37Size(size: Agent37Size): Promise<VercelStatus> {
    return this.serialize(async () => {
      const stored = await this.read();
      if (!stored.agent37) throw new Error("Connect Agent37 first.");
      return this.write({ ...stored, agent37: { ...stored.agent37, size } });
    });
  }

  /** Forgets the Agent37 key; instances made with it stay on Agent37 until removed there. */
  disconnectAgent37(): Promise<VercelStatus> {
    return this.serialize(async () => {
      const { agent37: _agent37, ...rest } = await this.read();
      return this.write(rest);
    });
  }

  /** Which connected service new cloud threads run on. */
  chooseService(service: CloudService): Promise<VercelStatus> {
    return this.serialize(async () => {
      const stored = await this.read();
      if (serviceOf({ ...stored, service }) !== service) throw new Error(service === "vercel" ? "Connect Vercel first." : "Connect Agent37 first.");
      return this.write({ ...stored, service });
    });
  }

  /** Whether working conversations move to the cloud when this Mac goes to sleep. */
  takeover(): Promise<boolean> {
    return this.serialize(async () => (await this.read().catch(() => ({}) as Stored)).takeover ?? false);
  }

  setTakeover(enabled: boolean): Promise<VercelStatus> {
    return this.serialize(async () => this.write({ ...(await this.read()), takeover: enabled }));
  }

  /** The size of sandboxes made from now on. Vercel refuses more than the team's plan allows when it makes one. */
  chooseSize(vcpus: number): Promise<VercelStatus> {
    return this.serialize(async () => {
      const stored = await this.read();
      if (!stored.vercel) throw new Error("Connect Vercel first.");
      return this.write({ ...stored, vercel: { ...stored.vercel, vcpus } });
    });
  }

  /** The region of sandboxes made from now on. One that exists stays where it was made. */
  chooseRegion(region: BrainRegion): Promise<VercelStatus> {
    return this.serialize(async () => {
      const stored = await this.read();
      if (!stored.vercel) throw new Error("Connect Vercel first.");
      return this.write({ ...stored, vercel: { ...stored.vercel, region } });
    });
  }

  /** Saves a token Vercel accepts. With one team, that team is chosen too. */
  connect(token: string): Promise<{ status: VercelStatus; teams: CloudTeam[] }> {
    return this.serialize(async () => {
      const teams = await this.teamsFor(token);
      const stored = await this.read();
      const only = teams.length === 1 ? teams[0]! : null;
      const vercel = only ? { token, team: only, project: await this.projectOn(token, only) } : { token };
      return { status: await this.write({ ...stored, vercel }), teams };
    });
  }

  teams(): Promise<CloudTeam[]> {
    return this.serialize(async () => {
      const token = (await this.read()).vercel?.token;
      if (!token) throw new Error("Connect Vercel first.");
      return this.teamsFor(token);
    });
  }

  chooseTeam(teamId: string): Promise<VercelStatus> {
    return this.serialize(async () => {
      const stored = await this.read();
      const token = stored.vercel?.token;
      if (!token) throw new Error("Connect Vercel first.");
      const team = (await this.teamsFor(token)).find((candidate) => candidate.id === teamId);
      if (!team) throw new Error("That team is not on this Vercel account.");
      return this.write({ ...stored, vercel: { ...stored.vercel, token, team, project: await this.projectOn(token, team) } });
    });
  }

  /** What a saved token reaches is asked of Vercel once, when Settings first looks after it was saved. */
  private async withReach(stored: Stored): Promise<Stored> {
    if (!stored.vercel || stored.vercel.reach !== undefined || this.reachAskedFor === stored.vercel.token) return stored;
    this.reachAskedFor = stored.vercel.token;
    const reach = await this.reachOf(stored.vercel.token);
    if (reach === undefined) return stored;
    await this.write({ ...stored, vercel: { ...stored.vercel, reach } });
    return this.read();
  }

  /** Forgets Vercel; where sandboxes run on this Mac stays chosen. */
  disconnect(): Promise<VercelStatus> {
    return this.serialize(async () => {
      const { vercel: _vercel, ...rest } = await this.read();
      return this.write(rest);
    });
  }
}
