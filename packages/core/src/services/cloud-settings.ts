import type { VercelCredentials } from "@openorc/cloud";
import type { CloudStatus, CloudTeam } from "@openorc/protocol";
import type { ProtectedSecretStore } from "./extraction-credentials.js";

/** The project on the chosen team that cloud threads' sandboxes belong to. */
export const SANDBOX_PROJECT = "openorc-sandboxes";
const API = "https://api.vercel.com";
const storageError = "Cannot access protected storage for cloud credentials. Unlock your OS keychain and retry.";

interface Stored {
  vercel?: { token: string; team?: CloudTeam; project?: { id: string; name: string } };
}

/** The Vercel part of what Settings shows. */
export type VercelStatus = Pick<CloudStatus, "vercel" | "error">;

export type VercelRequest = (url: string, init: RequestInit) => Promise<Response>;

function view(stored: Stored): VercelStatus {
  const vercel = stored.vercel;
  return { vercel: vercel ? { team: vercel.team ?? null, project: vercel.project?.name ?? null } : null, error: null };
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

  constructor(
    private readonly store: ProtectedSecretStore | undefined,
    private readonly request: VercelRequest = (url, init) => fetch(url, init),
  ) {}

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
    return view(next);
  }

  private async call<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ response: Response; body: T | null }> {
    const response = await this.request(`${API}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
    return { response, body: response.ok ? ((await response.json()) as T) : null };
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
        return view(await this.read());
      } catch (error) {
        return { vercel: null, error: error instanceof Error ? error.message : storageError };
      }
    });
  }

  /** What a Vercel sandbox needs, or null until Vercel is connected and a team is chosen. */
  credentials(): Promise<VercelCredentials | null> {
    return this.serialize(async () => {
      const vercel = (await this.read().catch(() => ({}) as Stored)).vercel;
      if (!vercel?.team || !vercel.project) return null;
      return { token: vercel.token, teamId: vercel.team.id, projectId: vercel.project.id };
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
      return this.write({ ...stored, vercel: { token, team, project: await this.projectOn(token, team) } });
    });
  }

  disconnect(): Promise<VercelStatus> {
    return this.serialize(async () => this.write({}));
  }
}
