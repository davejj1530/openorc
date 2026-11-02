import { describe, expect, it } from "vitest";
import { CloudSettings, SANDBOX_PROJECT, type VercelRequest } from "./cloud-settings.js";

const TOKEN = "vercel-token-123";

/** Vercel's REST API as cloud settings use it: teams, and one project per team that may not exist yet. */
function fakeVercel(teams: { id: string; name: string | null; slug: string }[], existing: Record<string, string> = {}) {
  const calls: string[] = [];
  const projects = { ...existing };
  const request: VercelRequest = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    calls.push(`${init.method ?? "GET"} ${pathname}`);
    if ((init.headers as Record<string, string>)["authorization"] !== `Bearer ${TOKEN}`) return Response.json({ error: { message: "Not authorized" } }, { status: 403 });
    const team = searchParams.get("teamId") ?? "";
    if (pathname === "/v2/teams") return Response.json({ teams });
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

describe("cloud settings", () => {
  it("connects with one team, makes its sandbox project, and gives sandboxes both tokens", async () => {
    const vercel = fakeVercel([{ id: "team_a", name: "Acme", slug: "acme" }]);
    const store = memoryStore();
    const settings = new CloudSettings(store, vercel.request);
    expect(await settings.credentials()).toBeNull();

    const { status, teams } = await settings.connect(TOKEN);
    expect(teams).toEqual([{ id: "team_a", name: "Acme" }]);
    expect(status).toEqual({ vercel: { team: { id: "team_a", name: "Acme" }, project: SANDBOX_PROJECT }, claude: false, error: null });
    expect(vercel.calls).toEqual(["GET /v2/teams", `GET /v9/projects/${SANDBOX_PROJECT}`, "POST /v11/projects"]);

    await settings.saveClaudeToken("sk-ant-oat-claude");
    expect(await settings.credentials()).toEqual({ token: TOKEN, teamId: "team_a", projectId: "prj_team_a", claudeToken: "sk-ant-oat-claude" });
    expect(await new CloudSettings(store, vercel.request).status()).toEqual({ vercel: { team: { id: "team_a", name: "Acme" }, project: SANDBOX_PROJECT }, claude: true, error: null });
  });

  it("waits for a team choice when the token reaches several, and reuses a project that exists", async () => {
    const vercel = fakeVercel(
      [
        { id: "team_a", name: "Acme", slug: "acme" },
        { id: "team_b", name: null, slug: "side-project" },
      ],
      { team_b: "prj_existing" },
    );
    const settings = new CloudSettings(memoryStore(), vercel.request);
    const { status, teams } = await settings.connect(TOKEN);
    expect(status.vercel).toEqual({ team: null, project: null });
    expect(teams.map((team) => team.name)).toEqual(["Acme", "side-project"]);
    expect(await settings.credentials()).toBeNull();

    expect(await settings.chooseTeam("team_b")).toMatchObject({ vercel: { team: { id: "team_b", name: "side-project" }, project: SANDBOX_PROJECT } });
    expect(vercel.calls.filter((call) => call.startsWith("POST"))).toEqual([]);
    expect(await settings.credentials()).toMatchObject({ teamId: "team_b", projectId: "prj_existing" });
    await expect(settings.chooseTeam("team_z")).rejects.toThrow("That team is not on this Vercel account.");
  });

  it("refuses a token Vercel does not accept and saves nothing", async () => {
    const store = memoryStore();
    const settings = new CloudSettings(store, fakeVercel([]).request);
    await expect(settings.connect("wrong-token")).rejects.toThrow("Vercel did not accept that token.");
    expect(store.peek()).toBeNull();
  });

  it("disconnects Vercel and removes the Claude token separately", async () => {
    const settings = new CloudSettings(memoryStore(), fakeVercel([{ id: "team_a", name: "Acme", slug: "acme" }]).request);
    await settings.connect(TOKEN);
    await settings.saveClaudeToken("sk-ant-oat-claude");
    expect(await settings.disconnect()).toEqual({ vercel: null, claude: true, error: null });
    expect(await settings.credentials()).toBeNull();
    expect(await settings.removeClaudeToken()).toEqual({ vercel: null, claude: false, error: null });
  });

  it("reports storage it cannot open without exposing anything", async () => {
    const settings = new CloudSettings({ load: () => Promise.reject(new Error("keychain locked")), save: async () => {} }, fakeVercel([]).request);
    expect(await settings.status()).toEqual({ vercel: null, claude: false, error: expect.stringContaining("protected storage") });
    expect(await settings.credentials()).toBeNull();
  });
});
