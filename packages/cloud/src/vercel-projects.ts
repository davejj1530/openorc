const API = "https://api.vercel.com";

export type VercelRequest = (url: string, init: RequestInit) => Promise<Response>;

export interface VercelProject {
  id: string;
  name: string;
}

/** Vercel's own words about a refusal; never the request, which carries the token. */
async function refusal(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: { message?: unknown } } | null;
  return typeof body?.error?.message === "string" ? body.error.message : `Vercel answered ${response.status}.`;
}

async function project(response: Response): Promise<VercelProject> {
  const body: unknown = await response.json();
  if (typeof body === "object" && body !== null && "id" in body && "name" in body && typeof body.id === "string" && typeof body.name === "string") return { id: body.id, name: body.name };
  throw new Error("Vercel answered without a project.");
}

/** The team's project with this name, made when missing. Errors carry Vercel's refusal, never the token. */
export async function ensureVercelProject(token: string, teamId: string, name: string, request: VercelRequest = (url, init) => fetch(url, init)): Promise<VercelProject> {
  const query = `?teamId=${encodeURIComponent(teamId)}`;
  const headers = { authorization: `Bearer ${token}` };
  const found = await request(`${API}/v9/projects/${encodeURIComponent(name)}${query}`, { method: "GET", headers });
  if (found.ok) return project(found);
  if (found.status !== 404) throw new Error(await refusal(found));
  const made = await request(`${API}/v11/projects${query}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name }) });
  if (!made.ok) throw new Error(`Could not make the ${name} project: ${await refusal(made)}`);
  return project(made);
}
