import { VERCEL_API, ensureVercelProject, findVercelProject, vercelRefusal, type VercelProject, type VercelRequest } from "../vercel-projects.js";
import { DOOR_PROJECT, brainDoor } from "./door.js";
import { encodeDoorConfig, type DoorConfig } from "./wire.js";

/** The door's function, which Vercel serves at the path phones knock on. */
const DOOR_FILE = "api/door.mjs";
const DOOR_PATH = "/api/door";
const DOOR_ENV = "OPENORC_DOOR";
/**
 * Beside the Sandbox API, so a wake's many requests stay near. 300 s is Hobby's longest function and Pro takes it; Vercel
 * reads the region only from the deployment request.
 */
const DOOR_SHAPE = { region: "iad1", maxDuration: 300 } as const;
/** Project domains stay public, so phones reach the door's address; deployment URLs stay behind Vercel's login. */
const PROTECTION = "all_except_custom_domains";
const POLL_MS = 2000;
const READY_WITHIN_MS = 5 * 60_000;
const SERVING_WITHIN_MS = 60_000;
const LOOK_WITHIN_MS = 10_000;

/** The door's code as apps/brain's build makes it: one ES module with everything inside. */
export interface DoorBundle {
  /** A digest of the code: another release is other code. */
  release: string;
  code(): Promise<Buffer>;
}

export interface DoorAccess {
  token: string;
  teamId: string;
  /** DOOR_PROJECT unless given, as for a QA door kept apart from the person's own. */
  project?: string;
}

/** What a door is opened with: the brain's wake as its Mac makes it. Its mark is the door's to add. */
export type DoorOpening = Omit<DoorConfig, "mark">;

export interface DoorDeployOptions {
  /** Requests to api.vercel.com; fetch unless given. */
  request?: VercelRequest;
  /** What the door at its address answers, asked as a phone asks: no token. Null when nothing answers as a door; throws when nothing answers at all. */
  look?: (host: string) => Promise<{ mark: string | null } | null>;
  pollMs?: number;
  /** Called once when the door turns out stale and a deploy begins. */
  deploying?: () => void;
  /**
   * The mark this process last opened and tidied. While it is the one the door answers with, opening asks nothing
   * more; otherwise a current door still has superseded deployments deleted, as one a crash left behind.
   */
  tidied?: string | null;
}

export interface OpenedDoor {
  host: string;
  mark: string;
  deployed: boolean;
}

interface Deployment {
  uid: string;
  created: number;
  readyState?: string;
  state?: string;
  meta?: Record<string, string>;
}

/** Throws when the address cannot be reached at all, so a Mac that is offline never takes that for a missing door. */
async function lookAtDoor(host: string): Promise<{ mark: string | null } | null> {
  let response: Response;
  try {
    response = await fetch(`https://${host}${DOOR_PATH}`, { cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(LOOK_WITHIN_MS) });
  } catch {
    throw new Error("Could not reach the door's address.");
  }
  if (!response.ok) return null;
  const body = (await response.json().catch(() => null)) as { door?: unknown; mark?: unknown } | null;
  return body?.door === 1 ? { mark: typeof body.mark === "string" ? body.mark : null } : null;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The REST calls a door needs, each refused in Vercel's own words. */
function vercel(access: DoorAccess, request: VercelRequest) {
  const call = async <T>(method: string, path: string, doing: string, body?: unknown): Promise<T | null> => {
    const url = `${VERCEL_API}${path}${path.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(access.teamId)}`;
    const headers: Record<string, string> = { authorization: `Bearer ${access.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) };
    const response = await request(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status === 404 && method !== "POST") return null;
    if (!response.ok) throw await vercelRefusal(response, doing);
    return response.status === 204 ? null : ((await response.json().catch(() => null)) as T | null);
  };
  return {
    call,
    ensure: (): Promise<VercelProject> => ensureVercelProject(access.token, access.teamId, access.project ?? DOOR_PROJECT, request),
    find: (): Promise<VercelProject | null> => findVercelProject(access.token, access.teamId, access.project ?? DOOR_PROJECT, request),
    // A door keeps one deployment, and a few more only after runs that died, so one page holds them all.
    deployments: async (project: VercelProject): Promise<Deployment[]> =>
      (await call<{ deployments: Deployment[] }>("GET", `/v6/deployments?projectId=${project.id}&limit=100`, "list the door's deployments"))?.deployments ?? [],
    drop: (id: string) => call("DELETE", `/v13/deployments/${id}`, "delete a door deployment"),
  };
}

type Rest = ReturnType<typeof vercel>;

/** Deletes every deployment of the door's project but the ones kept. Each holds the secrets it was built with. */
async function tidy(rest: Rest, project: VercelProject, keep: (deployment: Deployment) => boolean): Promise<void> {
  for (const deployment of await rest.deployments(project)) if (!keep(deployment)) await rest.drop(deployment.uid);
}

async function keepAddressPublic(rest: Rest, project: VercelProject): Promise<void> {
  const found = await rest.call<{ ssoProtection?: { deploymentType?: string } | null }>("GET", `/v9/projects/${project.id}`, "read the door's protection");
  if (found?.ssoProtection?.deploymentType === PROTECTION) return;
  await rest.call("PATCH", `/v9/projects/${project.id}`, "set the door's protection", { ssoProtection: { deploymentType: PROTECTION } });
}

async function addHost(rest: Rest, project: VercelProject, host: string): Promise<void> {
  if (await rest.call("GET", `/v9/projects/${project.id}/domains/${host}`, "read the door's address")) return;
  await rest.call("POST", `/v10/projects/${project.id}/domains`, "give the door its address", { name: host });
}

async function deploy(rest: Rest, project: VercelProject, code: Buffer, mark: string): Promise<string> {
  const files = [
    { file: DOOR_FILE, data: code.toString("utf8"), encoding: "utf-8" },
    { file: "vercel.json", data: JSON.stringify({ functions: { [DOOR_FILE]: { maxDuration: DOOR_SHAPE.maxDuration } } }), encoding: "utf-8" },
  ];
  const body = {
    name: project.name,
    project: project.id,
    target: "production",
    regions: [DOOR_SHAPE.region],
    files,
    meta: { openorcDoor: mark },
    projectSettings: { framework: null, buildCommand: null, installCommand: null, outputDirectory: null },
  };
  const made = await rest.call<{ id: string }>("POST", "/v13/deployments?skipAutoDetectionConfirmation=1&forceNew=1", "deploy the door", body);
  if (!made?.id) throw new Error("Vercel answered the door's deployment without an id.");
  return made.id;
}

async function ready(rest: Rest, id: string, pollMs: number): Promise<void> {
  const deadline = Date.now() + READY_WITHIN_MS;
  for (;;) {
    const found = await rest.call<{ readyState?: string; errorMessage?: string }>("GET", `/v13/deployments/${id}`, "follow the door's deployment");
    if (found?.readyState === "READY") return;
    if (found?.readyState === "ERROR" || found?.readyState === "CANCELED") throw new Error(`The door did not deploy: ${found.errorMessage ?? found.readyState.toLowerCase()}`);
    if (Date.now() + pollMs > deadline) throw new Error("The door did not deploy in time.");
    await delay(pollMs);
  }
}

async function serving(look: NonNullable<DoorDeployOptions["look"]>, host: string, mark: string, pollMs: number): Promise<void> {
  const deadline = Date.now() + SERVING_WITHIN_MS;
  while ((await look(host).catch(() => null))?.mark !== mark) {
    if (Date.now() + pollMs > deadline) throw new Error("The door deployed, but its address does not answer with it yet.");
    await delay(pollMs);
  }
}

/**
 * Makes the door in the person's team hold `opening` with `bundle`'s code: one production deployment at the door's
 * address, the others deleted. Safe to repeat. A door that answers with the wanted mark costs one look; a deploy that
 * fails leaves the old door serving; a run that died halfway converges on the next.
 */
export async function openDoor(access: DoorAccess, opening: DoorOpening, bundle: DoorBundle, options: DoorDeployOptions = {}): Promise<OpenedDoor> {
  const door = brainDoor(opening.key);
  const mark = door.mark(bundle.release, DOOR_SHAPE, opening);
  const look = options.look ?? lookAtDoor;
  const rest = vercel(access, options.request ?? ((url, init) => fetch(url, init)));
  const pollMs = options.pollMs ?? POLL_MS;
  const served = (await look(door.host))?.mark === mark;
  if (served && options.tidied === mark) return { host: door.host, mark, deployed: false };
  const project = await rest.ensure();
  if (served) {
    const newest = (await rest.deployments(project)).filter((each) => each.meta?.["openorcDoor"] === mark && (each.readyState ?? each.state) === "READY").sort((a, b) => b.created - a.created)[0];
    await tidy(rest, project, (each) => each.uid === newest?.uid);
    return { host: door.host, mark, deployed: false };
  }
  options.deploying?.();
  await keepAddressPublic(rest, project);
  const env = await rest.call<{ failed?: { error?: { message?: string } }[] }>("POST", `/v10/projects/${project.id}/env?upsert=true`, "give the door its config", [
    { key: DOOR_ENV, value: encodeDoorConfig({ ...opening, mark }), type: "sensitive", target: ["production"] },
  ]);
  // Vercel answers a batch with what failed in it, not with an error.
  if (env?.failed?.length) throw new Error(`Could not give the door its config: ${env.failed[0]?.error?.message ?? "Vercel refused it."}`);
  await addHost(rest, project, door.host);
  const id = await deploy(rest, project, await bundle.code(), mark);
  await ready(rest, id, pollMs);
  await serving(look, door.host, mark, pollMs);
  await tidy(rest, project, (each) => each.uid === id);
  return { host: door.host, mark, deployed: true };
}

/** Deletes the door's deployments, then its copy of the config with the token; the project stays for the next open. */
export async function closeDoor(access: DoorAccess, options: Pick<DoorDeployOptions, "request"> = {}): Promise<void> {
  const rest = vercel(access, options.request ?? ((url, init) => fetch(url, init)));
  const project = await rest.find();
  if (!project) return;
  await tidy(rest, project, () => false);
  const envs = (await rest.call<{ envs: { id: string; key: string }[] }>("GET", `/v10/projects/${project.id}/env`, "list the door's config"))?.envs ?? [];
  for (const env of envs.filter((each) => each.key === DOOR_ENV)) await rest.call("DELETE", `/v9/projects/${project.id}/env/${env.id}`, "delete the door's config");
}

/**
 * Deletes each of the door's deployments, then its project. A deployment outlives its project for as long as something
 * keeps calling it, so each goes first.
 */
export async function removeDoor(access: DoorAccess, options: Pick<DoorDeployOptions, "request"> = {}): Promise<void> {
  const rest = vercel(access, options.request ?? ((url, init) => fetch(url, init)));
  const project = await rest.find();
  if (!project) return;
  await tidy(rest, project, () => false);
  await rest.call("DELETE", `/v9/projects/${project.id}`, "delete the door's project");
}
