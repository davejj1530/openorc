import { describe, expect, it, vi } from "vitest";
import { brainDoor } from "./door.js";
import { closeDoor, openDoor, removeDoor, type DoorBundle, type DoorOpening } from "./door-deploy.js";
import { readDoorConfig, type BrainKey } from "./wire.js";

const TOKEN = "vcp_7f3k2m9q8w1e4r6t5y0uSECRET";
const TEAM = "team_1";
const KEY = Uint8Array.from({ length: 32 }, (_, i) => i) as BrainKey;
const HOST = brainDoor(KEY).host;
const opening: DoorOpening = { key: KEY, vercel: { token: TOKEN, teamId: TEAM, project: "openorc-brain" }, name: "Cloud", revoked: [] };
const bundle = (release = "r1"): DoorBundle => ({ release, code: async () => Buffer.from(`export const release = "${release}";`) });

interface Env {
  id: string;
  key: string;
  value: string;
  type: string;
  target: string[];
}
interface Deployment {
  uid: string;
  created: number;
  readyState: string;
  meta: Record<string, string>;
  /** The env it was built with, as Vercel snapshots it. */
  env: Record<string, string>;
  body: Record<string, unknown>;
}

/** Vercel's REST as the door uses it: one team, projects by name, env, domains, deployments, and who answers where. */
class FakeVercel {
  projects = new Map<string, { id: string; name: string; ssoProtection: { deploymentType: string } | null; env: Env[]; domains: string[] }>();
  deployments: (Deployment & { project: string })[] = [];
  calls: string[] = [];
  looks = 0;
  /** Each deploy ends in this state. */
  outcome: "READY" | "ERROR" = "READY";
  failNext: string | null = null;
  /** Its env upsert answers 201 with the entry under failed, as Vercel does for a batch. */
  envFails = false;
  teamProtection: { deploymentType: string } | null = { deploymentType: "all_except_custom_domains" };
  private clock = 0;

  request = async (url: string, init: RequestInit): Promise<Response> => {
    const parsed = new URL(url);
    const method = init.method ?? "GET";
    const call = `${method} ${parsed.pathname}`;
    this.calls.push(call);
    expect(parsed.searchParams.get("teamId")).toBe(TEAM);
    expect((init.headers as Record<string, string>)["authorization"]).toBe(`Bearer ${TOKEN}`);
    if (this.failNext && call.startsWith(this.failNext)) {
      this.failNext = null;
      return Response.json({ error: { message: "Vercel is having a moment." } }, { status: 500 });
    }
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    return this.answer(method, parsed, body);
  };

  look = async (host: string) => {
    this.looks += 1;
    const project = [...this.projects.values()].find((each) => each.domains.includes(host));
    const live = this.deployments.filter((each) => each.project === project?.id && each.readyState === "READY").sort((a, b) => b.created - a.created)[0];
    return live ? { mark: readDoorConfig(live.env["OPENORC_DOOR"])?.mark ?? null } : null;
  };

  byId = (id: string) => [...this.projects.values()].find((project) => project.id === id || project.name === id);
  live = (name = "openorc-door") => this.deployments.filter((each) => each.project === this.byId(name)?.id);

  private answer(method: string, url: URL, body: any): Response {
    const path = url.pathname;
    let match: RegExpExecArray | null;
    if (method === "POST" && path === "/v11/projects") {
      const project = { id: `prj_${this.projects.size + 1}`, name: body.name, ssoProtection: this.teamProtection, env: [], domains: [] };
      this.projects.set(body.name, project);
      return Response.json({ id: project.id, name: project.name });
    }
    if ((match = /^\/v9\/projects\/([^/]+)$/.exec(path))) {
      const project = this.byId(decodeURIComponent(match[1]!));
      if (!project) return Response.json({ error: { message: "not found" } }, { status: 404 });
      if (method === "GET") return Response.json({ id: project.id, name: project.name, ssoProtection: project.ssoProtection });
      if (method === "PATCH") return ((project.ssoProtection = body.ssoProtection), Response.json({}));
      if (method === "DELETE") {
        this.projects.delete(project.name);
        return new Response(null, { status: 204 });
      }
    }
    if ((match = /^\/v10\/projects\/([^/]+)\/env$/.exec(path))) {
      const project = this.byId(match[1]!)!;
      if (method === "GET") return Response.json({ envs: project.env.map(({ id, key, type }) => ({ id, key, type })) });
      expect(url.searchParams.get("upsert")).toBe("true");
      if (this.envFails) return Response.json({ created: [], failed: [{ error: { code: "ENV_CONFLICT", message: "A variable with this name is in the way." } }] }, { status: 201 });
      for (const entry of body as Omit<Env, "id">[]) {
        project.env = project.env.filter((each) => each.key !== entry.key);
        project.env.push({ ...entry, id: `env_${++this.clock}` });
      }
      return Response.json({ created: body });
    }
    if ((match = /^\/v9\/projects\/([^/]+)\/env\/([^/]+)$/.exec(path)) && method === "DELETE") {
      const project = this.byId(match[1]!)!;
      project.env = project.env.filter((each) => each.id !== match![2]);
      return Response.json({});
    }
    if ((match = /^\/v9\/projects\/([^/]+)\/domains\/([^/]+)$/.exec(path))) {
      return this.byId(match[1]!)!.domains.includes(match[2]!) ? Response.json({ name: match[2] }) : Response.json({ error: { message: "not found" } }, { status: 404 });
    }
    if ((match = /^\/v10\/projects\/([^/]+)\/domains$/.exec(path))) {
      this.byId(match[1]!)!.domains.push(body.name);
      return Response.json({ name: body.name, verified: true });
    }
    if (method === "POST" && path === "/v13/deployments") {
      const project = this.byId(body.project)!;
      const env = Object.fromEntries(project.env.filter((each) => each.target.includes("production")).map((each) => [each.key, each.value]));
      const deployment = { uid: `dpl_${++this.clock}`, created: this.clock, readyState: "BUILDING", meta: body.meta, env, body, project: project.id };
      this.deployments.push(deployment);
      return Response.json({ id: deployment.uid });
    }
    if ((match = /^\/v13\/deployments\/([^/]+)$/.exec(path))) {
      const deployment = this.deployments.find((each) => each.uid === match![1]);
      if (!deployment) return Response.json({ error: { message: "not found" } }, { status: 404 });
      if (method === "DELETE") {
        this.deployments = this.deployments.filter((each) => each !== deployment);
        return Response.json({ state: "DELETED" });
      }
      if (deployment.readyState === "BUILDING") deployment.readyState = this.outcome;
      return Response.json({ readyState: deployment.readyState, ...(deployment.readyState === "ERROR" ? { errorMessage: "invalid_max_duration" } : {}) });
    }
    if (method === "GET" && path === "/v6/deployments") {
      const project = url.searchParams.get("projectId")!;
      return Response.json({ deployments: this.deployments.filter((each) => each.project === project).map(({ uid, created, readyState, meta }) => ({ uid, created, readyState, meta })) });
    }
    throw new Error(`the fake has no ${method} ${path}`);
  }
}

const options = (vercel: FakeVercel, extra = {}) => ({ request: vercel.request, look: vercel.look, pollMs: 0, ...extra });
const access = { token: TOKEN, teamId: TEAM };

describe("opening the door", () => {
  it("makes its project, holds the config as a sensitive env var, gives it its address, and deploys it to iad1", async () => {
    const vercel = new FakeVercel();
    vercel.teamProtection = { deploymentType: "all" };
    let deploying = 0;
    const opened = await openDoor(access, opening, bundle(), options(vercel, { deploying: () => deploying++ }));
    expect(opened).toMatchObject({ host: HOST, deployed: true });
    expect(deploying).toBe(1);
    const project = vercel.byId("openorc-door")!;
    expect(project.ssoProtection).toEqual({ deploymentType: "all_except_custom_domains" });
    expect(project.domains).toEqual([HOST]);
    expect(project.env).toEqual([expect.objectContaining({ key: "OPENORC_DOOR", type: "sensitive", target: ["production"] })]);
    expect(readDoorConfig(project.env[0]!.value)).toEqual({ ...opening, mark: opened.mark });
    const [deployment] = vercel.live();
    expect(vercel.live()).toHaveLength(1);
    expect(deployment!.body).toMatchObject({ target: "production", regions: ["iad1"], meta: { openorcDoor: opened.mark } });
    const files = deployment!.body["files"] as { file: string; data: string }[];
    expect(files.map((file) => file.file)).toEqual(["api/door.mjs", "vercel.json"]);
    expect(JSON.parse(files[1]!.data)).toEqual({ functions: { "api/door.mjs": { maxDuration: 300 } } });
    expect(await vercel.look(HOST)).toEqual({ mark: opened.mark });
    expect(vercel.byId("openorc-brain")).toBeUndefined();
  });

  it("leaves protection that already keeps the address public alone", async () => {
    const vercel = new FakeVercel();
    await openDoor(access, opening, bundle(), options(vercel));
    expect(vercel.calls.filter((call) => call.startsWith("PATCH"))).toEqual([]);
  });

  it("asks only the door itself once it is current and tidied", async () => {
    const vercel = new FakeVercel();
    const opened = await openDoor(access, opening, bundle(), options(vercel));
    vercel.calls = [];
    vercel.looks = 0;
    const again = await openDoor(access, opening, bundle(), options(vercel, { tidied: opened.mark, deploying: () => expect.unreachable() }));
    expect(again).toEqual({ host: HOST, mark: opened.mark, deployed: false });
    expect(vercel.calls).toEqual([]);
    expect(vercel.looks).toBe(1);
  });

  it("deploys again when the config or the code changes, and keeps only the new deployment", async () => {
    const vercel = new FakeVercel();
    const first = await openDoor(access, opening, bundle(), options(vercel));
    const token = { ...opening, threadVcpus: 4 };
    const second = await openDoor(access, token, bundle(), options(vercel, { tidied: first.mark }));
    expect(second.deployed).toBe(true);
    expect(second.mark).not.toBe(first.mark);
    const third = await openDoor(access, token, bundle("r2"), options(vercel, { tidied: second.mark }));
    expect(third.deployed).toBe(true);
    expect(vercel.live().map((each) => each.meta["openorcDoor"])).toEqual([third.mark]);
  });

  it("keeps the old door serving when a deploy fails", async () => {
    const vercel = new FakeVercel();
    const first = await openDoor(access, opening, bundle(), options(vercel));
    vercel.outcome = "ERROR";
    await expect(openDoor(access, opening, bundle("r2"), options(vercel, { tidied: first.mark }))).rejects.toThrow("The door did not deploy: invalid_max_duration");
    expect(await vercel.look(HOST)).toEqual({ mark: first.mark });
    expect(vercel.live().filter((each) => each.readyState === "READY")).toHaveLength(1);
  });

  it("converges after a run that died halfway: before the deploy, and after it served but before the old one went", async () => {
    const vercel = new FakeVercel();
    const first = await openDoor(access, opening, bundle(), options(vercel));
    vercel.failNext = "POST /v13/deployments";
    await expect(openDoor(access, opening, bundle("r2"), options(vercel, { tidied: first.mark }))).rejects.toThrow("Could not deploy the door: Vercel is having a moment.");
    const second = await openDoor(access, opening, bundle("r2"), options(vercel, { tidied: first.mark }));
    expect(vercel.live().map((each) => each.meta["openorcDoor"])).toEqual([second.mark]);

    vercel.failNext = "GET /v6/deployments";
    await expect(openDoor(access, opening, bundle("r3"), options(vercel, { tidied: second.mark }))).rejects.toThrow("Could not list the door's deployments");
    expect(vercel.live()).toHaveLength(2);
    const third = await openDoor(access, opening, bundle("r3"), options(vercel));
    expect(third.deployed).toBe(false);
    expect(vercel.live().map((each) => each.meta["openorcDoor"])).toEqual([third.mark]);
  });

  it("deploys nothing when the config did not take, and the old door keeps serving", async () => {
    const vercel = new FakeVercel();
    const first = await openDoor(access, opening, bundle(), options(vercel));
    vercel.envFails = true;
    await expect(openDoor(access, opening, bundle("r2"), options(vercel, { tidied: first.mark }))).rejects.toThrow("Could not give the door its config: A variable with this name is in the way.");
    expect(vercel.calls.filter((call) => call === "POST /v13/deployments")).toHaveLength(1);
    expect(await vercel.look(HOST)).toEqual({ mark: first.mark });
  });

  it("deploys nothing when the door's address cannot be reached, as from a Mac that is offline", async () => {
    const vercel = new FakeVercel();
    const looked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      looked.push(url);
      throw new TypeError("fetch failed");
    });
    try {
      await expect(openDoor(access, opening, bundle(), { request: vercel.request, pollMs: 0 })).rejects.toThrow("Could not reach the door's address.");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(looked).toEqual([`https://${HOST}/api/door`]);
    expect(vercel.calls).toEqual([]);
  });

  it("never puts the token in what it throws", async () => {
    const vercel = new FakeVercel();
    vercel.failNext = "POST /v11/projects";
    const error: unknown = await openDoor(access, opening, bundle(), options(vercel)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Vercel is having a moment.");
    expect((error as Error).message).not.toContain(TOKEN);
  });
});

describe("closing and removing the door", () => {
  it("closing deletes every deployment, then the config with the token, and keeps the project", async () => {
    const vercel = new FakeVercel();
    await openDoor(access, opening, bundle(), options(vercel));
    await openDoor(access, { ...opening, revoked: ["phone-1"] }, bundle(), options(vercel));
    vercel.calls = [];
    await closeDoor(access, { request: vercel.request });
    expect(vercel.live()).toEqual([]);
    expect(vercel.byId("openorc-door")!.env).toEqual([]);
    expect(vercel.calls.findIndex((call) => call.startsWith("DELETE /v9/projects/prj_1/env"))).toBeGreaterThan(
      vercel.calls.lastIndexOf(vercel.calls.find((call) => call.startsWith("DELETE /v13/deployments"))!),
    );
    expect(await vercel.look(HOST)).toBeNull();
  });

  it("removing deletes each deployment before the project", async () => {
    const vercel = new FakeVercel();
    await openDoor(access, opening, bundle(), options(vercel));
    const [deployment] = vercel.live();
    vercel.calls = [];
    await removeDoor(access, { request: vercel.request });
    expect(vercel.byId("openorc-door")).toBeUndefined();
    expect(vercel.deployments).toEqual([]);
    expect(vercel.calls.filter((call) => call.startsWith("DELETE"))).toEqual([`DELETE /v13/deployments/${deployment!.uid}`, "DELETE /v9/projects/prj_1"]);
  });

  it("closing or removing a door that was never opened asks once and changes nothing", async () => {
    const vercel = new FakeVercel();
    await closeDoor(access, { request: vercel.request });
    await removeDoor(access, { request: vercel.request });
    expect(vercel.calls).toEqual(["GET /v9/projects/openorc-door", "GET /v9/projects/openorc-door"]);
  });

  it("opens, closes and removes a door in the project it is given", async () => {
    const vercel = new FakeVercel();
    await openDoor({ ...access, project: "openorc-door-qa" }, opening, bundle(), options(vercel));
    expect(vercel.byId("openorc-door")).toBeUndefined();
    expect(vercel.live("openorc-door-qa")).toHaveLength(1);
    await removeDoor({ ...access, project: "openorc-door-qa" }, { request: vercel.request });
    expect(vercel.byId("openorc-door-qa")).toBeUndefined();
  });
});
