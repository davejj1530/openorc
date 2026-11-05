import { APIError } from "@vercel/sandbox";

export const VERCEL_API = "https://api.vercel.com";

export type VercelRequest = (url: string, init: RequestInit) => Promise<Response>;

export interface VercelProject {
  id: string;
  name: string;
}

/** Vercel refused a request, in its own words; never the request, which carries the token. */
export class VercelRefusal extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function vercelRefusal(response: Response, doing?: string): Promise<VercelRefusal> {
  const body = (await response.json().catch(() => null)) as { error?: { message?: unknown } } | null;
  const words = typeof body?.error?.message === "string" ? body.error.message : `Vercel answered ${response.status}.`;
  return new VercelRefusal(doing ? `Could not ${doing}: ${words}` : words, response.status);
}

/** Vercel refused the token itself, or its reach: only a new connection on the Mac can help. */
export function vercelDenied(error: unknown): boolean {
  const denied = (status: number) => status === 401 || status === 403;
  if (error instanceof VercelRefusal) return denied(error.status);
  return error instanceof APIError && denied(error.response.status);
}

async function project(response: Response): Promise<VercelProject> {
  const body: unknown = await response.json();
  if (typeof body === "object" && body !== null && "id" in body && "name" in body && typeof body.id === "string" && typeof body.name === "string") return { id: body.id, name: body.name };
  throw new Error("Vercel answered without a project.");
}

/** The team's project with this name, or null when it has none. Never makes one. */
export async function findVercelProject(token: string, teamId: string, name: string, request: VercelRequest = (url, init) => fetch(url, init)): Promise<VercelProject | null> {
  const found = await request(`${VERCEL_API}/v9/projects/${encodeURIComponent(name)}?teamId=${encodeURIComponent(teamId)}`, { method: "GET", headers: { authorization: `Bearer ${token}` } });
  if (found.ok) return project(found);
  if (found.status !== 404) throw await vercelRefusal(found);
  return null;
}

/** The team's project with this name, made when missing. Errors carry Vercel's refusal, never the token. */
export async function ensureVercelProject(token: string, teamId: string, name: string, request: VercelRequest = (url, init) => fetch(url, init)): Promise<VercelProject> {
  const found = await findVercelProject(token, teamId, name, request);
  if (found) return found;
  const made = await request(`${VERCEL_API}/v11/projects?teamId=${encodeURIComponent(teamId)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!made.ok) throw await vercelRefusal(made, `make the ${name} project`);
  return project(made);
}
