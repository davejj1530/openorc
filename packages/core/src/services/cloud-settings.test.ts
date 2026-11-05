import { describe, expect, it } from "vitest";
import { BRAIN_PROJECT } from "@openorc/cloud";
import { CloudSettings, SANDBOX_PROJECT, type CloudSettingsOptions, type VercelRequest } from "./cloud-settings.js";

const TOKEN = "vercel-token-123";

/**
 * Vercel's REST API as cloud settings use it: teams, one project per team that may not exist yet, and what the token
 * reaches, which Vercel refuses to say unless given.
 */
function fakeVercel(teams: { id: string; name: string | null; slug: string }[], existing: Record<string, string> = {}, scopes?: unknown[] | "down") {
  const calls: string[] = [];
  const projects = { ...existing };
  const request: VercelRequest = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    calls.push(`${init.method ?? "GET"} ${pathname}`);
    if (!(init.headers as Record<string, string>)["authorization"]?.startsWith(`Bearer ${TOKEN}`)) return Response.json({ error: { message: "Not authorized" } }, { status: 403 });
    const team = searchParams.get("teamId") ?? "";
    if (pathname === "/v2/teams") return Response.json({ teams });
    if (pathname === "/v5/user/tokens/current") {
      if (scopes === "down") throw new TypeError("fetch failed");
      return scopes
        ? Response.json({ token: { id: "tok_1", name: "OpenOrc", type: "token", activeAt: 1, createdAt: 1, scopes } })
        : Response.json({ error: { message: "Forbidden" } }, { status: 403 });
    }
    if (pathname === `/v9/projects/${SANDBOX_PROJECT}`)
      return projects[team] ? Response.json({ id: projects[team], name: SANDBOX_PROJECT }) : Response.json({ error: { message: "Not found" } }, { status: 404 });
    if (pathname === "/v11/projects" && init.method === "POST") {
      projects[team] = `prj_${team}`;
      return Response.json({ id: projects[team], name: JSON.parse(String(init.body)).name });
    }
    return new Response(null, { status: 500 });
  };
  return { request, calls };
}

function memoryStore() {
  let value: string | null = null;
  return {
    load: async () => value,
    save: async (next: string) => {
      value = next;
    },
    peek: () => value,
  };
}

/** Settings on a Mac in Berlin with no cloud brain, unless a test says otherwise. */
function cloudSettings(store: ConstructorParameters<typeof CloudSettings>[0], request: VercelRequest, options: CloudSettingsOptions = {}) {
  return new CloudSettings(store, { request, timeZone: () => "Europe/Berlin", ...options });
}

describe("cloud settings", () => {
  it("connects with one team, makes its sandbox project, and gives sandboxes its credentials", async () => {
    const vercel = fakeVercel([{ id: "team_a", name: "Acme", slug: "acme" }]);
    const store = memoryStore();
    const settings = cloudSettings(store, vercel.request);
    expect(await settings.credentials()).toBeNull();

    const { status, teams } = await settings.connect(TOKEN);
    expect(teams).toEqual([{ id: "team_a", name: "Acme" }]);
    expect(status).toEqual({ vercel: { team: { id: "team_a", name: "Acme" }, project: SANDBOX_PROJECT, vcpus: null, region: "fra1" }, error: null, takeover: false });
    expect(vercel.calls).toEqual(["GET /v2/teams", `GET /v9/projects/${SANDBOX_PROJECT}`, "POST /v11/projects"]);

    expect(await settings.credentials()).toEqual({ token: TOKEN, teamId: "team_a", projectId: "prj_team_a", region: "fra1" });
    expect(await cloudSettings(store, vercel.request).status()).toEqual({
      vercel: { team: { id: "team_a", name: "Acme" }, project: SANDBOX_PROJECT, vcpus: null, region: "fra1" },
      error: null,
      takeover: false,
    });
  });

  it("waits for a team choice when the token reaches several, and reuses a project that exists", async () => {
    const vercel = fakeVercel(
      [
        { id: "team_a", name: "Acme", slug: "acme" },
        { id: "team_b", name: null, slug: "side-project" },
      ],
      { team_b: "prj_existing" },
    );
    const settings = cloudSettings(memoryStore(), vercel.request);
    const { status, teams } = await settings.connect(TOKEN);
    expect(status.vercel).toEqual({ team: null, project: null, vcpus: null, region: "fra1" });
    expect(teams.map((team) => team.name)).toEqual(["Acme", "side-project"]);
    expect(await settings.credentials()).toBeNull();

    expect(await settings.chooseTeam("team_b")).toMatchObject({ vercel: { team: { id: "team_b", name: "side-project" }, project: SANDBOX_PROJECT } });
    expect(vercel.calls.filter((call) => call.startsWith("POST"))).toEqual([]);
    expect(await settings.credentials()).toMatchObject({ teamId: "team_b", projectId: "prj_existing" });
    await expect(settings.chooseTeam("team_z")).rejects.toThrow("That team is not on this Vercel account.");
  });

  it("keeps the size of new sandboxes with the connection, through a change of team", async () => {
    const vercel = fakeVercel([
      { id: "team_a", name: "Acme", slug: "acme" },
      { id: "team_b", name: "Beta", slug: "beta" },
    ]);
    const settings = cloudSettings(memoryStore(), vercel.request);
    await expect(settings.chooseSize(8)).rejects.toThrow("Connect Vercel first.");
    await settings.connect(TOKEN);
    await settings.chooseTeam("team_a");
    expect((await settings.chooseSize(8)).vercel?.vcpus).toBe(8);
    expect(await settings.credentials()).toMatchObject({ teamId: "team_a", vcpus: 8 });
    await settings.chooseTeam("team_b");
    expect(await settings.credentials()).toMatchObject({ teamId: "team_b", vcpus: 8 });
  });

  it("runs new sandboxes in the region nearest this Mac's time zone, or beside the cloud brain while there is one", async () => {
    let brain: "sin1" | null = null;
    const settings = cloudSettings(memoryStore(), fakeVercel([{ id: "team_a", name: "Acme", slug: "acme" }]).request, { timeZone: () => "Asia/Tokyo", brainRegion: async () => brain });
    expect((await settings.connect(TOKEN)).status.vercel?.region).toBe("hnd1");
    expect(await settings.credentials()).toMatchObject({ region: "hnd1" });
    brain = "sin1";
    expect((await settings.status()).vercel?.region).toBe("sin1");
    expect(await settings.credentials()).toMatchObject({ region: "sin1" });
  });

  it("keeps the region chosen over the brain's for sandboxes made from now on, through a change of team", async () => {
    const vercel = fakeVercel([
      { id: "team_a", name: "Acme", slug: "acme" },
      { id: "team_b", name: "Beta", slug: "beta" },
    ]);
    const settings = cloudSettings(memoryStore(), vercel.request, { brainRegion: async () => "sin1" });
    await expect(settings.chooseRegion("syd1")).rejects.toThrow("Connect Vercel first.");
    await settings.connect(TOKEN);
    await settings.chooseTeam("team_a");
    expect((await settings.chooseRegion("syd1")).vercel?.region).toBe("syd1");
    expect(await settings.credentials()).toMatchObject({ teamId: "team_a", region: "syd1" });
    await settings.chooseTeam("team_b");
    expect(await settings.credentials()).toMatchObject({ teamId: "team_b", region: "syd1" });
  });

  it("keeps carrying working threads on in the cloud as a choice of its own, through disconnecting Vercel", async () => {
    const settings = cloudSettings(memoryStore(), fakeVercel([{ id: "team_a", name: "Acme", slug: "acme" }]).request);
    expect(await settings.takeover()).toBe(false);
    expect((await settings.setTakeover(true)).takeover).toBe(true);
    await settings.connect(TOKEN);
    expect((await settings.disconnect()).takeover).toBe(true);
    expect(await settings.takeover()).toBe(true);
  });

  it("says when the saved token reaches more than the chosen team, as Vercel tells it, and nothing when Vercel will not say", async () => {
    const acme = { id: "team_a", name: "Acme", slug: "acme" };
    const beta = { id: "team_b", name: "Beta", slug: "beta" };
    const reach = async (teams: (typeof acme)[], scopes?: unknown[]) => {
      const settings = cloudSettings(memoryStore(), fakeVercel(teams, {}, scopes).request);
      await settings.connect(TOKEN);
      if (teams.length > 1) await settings.chooseTeam("team_a");
      return (await settings.status()).vercel?.reachesMore ?? false;
    };
    expect(await reach([acme], [{ type: "user", createdAt: 1, origin: "email" }])).toBe(true);
    expect(await reach([acme], [{ type: "team", teamId: "team_a", createdAt: 1 }])).toBe(false);
    expect(
      await reach(
        [acme, beta],
        [
          { type: "team", teamId: "team_a", createdAt: 1 },
          { type: "team", teamId: "team_b", createdAt: 1 },
        ],
      ),
    ).toBe(true);
    expect(await reach([acme], [])).toBe(true);
    expect(await reach([acme], [{ type: "project", projectId: "prj_1", createdAt: 1 }])).toBe(false);
    expect(await reach([acme])).toBe(false);
    const several = cloudSettings(memoryStore(), fakeVercel([acme, beta], {}, [{ type: "user", createdAt: 1 }]).request);
    await several.connect(TOKEN);
    expect((await several.status()).vercel).not.toHaveProperty("reachesMore");
  });

  it("asks once what a token saved before reaches, and again next time while Vercel cannot be asked", async () => {
    const store = memoryStore();
    await store.save(JSON.stringify({ vercel: { token: TOKEN, team: { id: "team_a", name: "Acme" }, project: { id: "prj_a", name: SANDBOX_PROJECT } } }));
    const down = fakeVercel([], {}, "down");
    const offline = cloudSettings(store, down.request);
    expect((await offline.status()).vercel).not.toHaveProperty("reachesMore");
    await offline.status();
    expect(down.calls).toEqual(["GET /v5/user/tokens/current"]);
    const vercel = fakeVercel([], {}, [{ type: "user", createdAt: 1 }]);
    const settings = cloudSettings(store, vercel.request);
    expect((await settings.status()).vercel?.reachesMore).toBe(true);
    expect((await cloudSettings(store, vercel.request).status()).vercel?.reachesMore).toBe(true);
    expect(vercel.calls).toEqual(["GET /v5/user/tokens/current"]);
    expect(store.peek()).not.toContain("scopes");

    const refused = fakeVercel([{ id: "team_a", name: "Acme", slug: "acme" }]);
    const quietStore = memoryStore();
    const quiet = cloudSettings(quietStore, refused.request);
    await quiet.connect(TOKEN);
    await quiet.status();
    await cloudSettings(quietStore, refused.request).status();
    expect(refused.calls.filter((call) => call.includes("tokens"))).toEqual(["GET /v5/user/tokens/current"]);
  });

  it("asks again about another token connected in place of the last", async () => {
    const vercel = fakeVercel([{ id: "team_a", name: "Acme", slug: "acme" }], {}, [{ type: "team", teamId: "team_a", createdAt: 1 }]);
    const settings = cloudSettings(memoryStore(), vercel.request);
    await settings.connect(TOKEN);
    await settings.status();
    await settings.disconnect();
    await settings.connect(`${TOKEN}-team`);
    await settings.status();
    expect(vercel.calls.filter((call) => call.includes("tokens"))).toHaveLength(2);
  });

  it("refuses a token Vercel does not accept and saves nothing", async () => {
    const store = memoryStore();
    const settings = cloudSettings(store, fakeVercel([]).request);
    await expect(settings.connect("wrong-token")).rejects.toThrow("Vercel did not accept that token.");
    expect(store.peek()).toBeNull();
  });

  it("disconnects Vercel", async () => {
    const settings = cloudSettings(memoryStore(), fakeVercel([{ id: "team_a", name: "Acme", slug: "acme" }]).request);
    await settings.connect(TOKEN);
    expect(await settings.disconnect()).toEqual({ vercel: null, error: null, takeover: false });
    expect(await settings.credentials()).toBeNull();
  });

  it("reports storage it cannot open without exposing anything", async () => {
    const settings = cloudSettings({ load: () => Promise.reject(new Error("keychain locked")), save: async () => {} }, fakeVercel([]).request);
    expect(await settings.status()).toEqual({ vercel: null, error: expect.stringContaining("protected storage"), takeover: false });
    expect(await settings.credentials()).toBeNull();
  });
});

describe("where the Mac's sandboxes live", () => {
  it("in a project apart from the cloud brain's, so Settings > Sandboxes never lists a brain thread's sandbox", () => {
    expect(SANDBOX_PROJECT).not.toBe(BRAIN_PROJECT);
  });
});
