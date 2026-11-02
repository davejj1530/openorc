import { describe, expect, it } from "vitest";
import { ensureVercelProject, findVercelProject, type VercelRequest } from "./vercel-projects.js";

const TOKEN = "vcp_secret_token_value";

/** Answers each call with the next response, and records what was asked. */
function vercel(...responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const request: VercelRequest = async (url, init) => {
    calls.push({ url, init });
    return responses.shift() ?? new Response(null, { status: 500 });
  };
  return { calls, request };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("finding or making a Vercel project", () => {
  it("returns the team's project when it exists, without making one", async () => {
    const { calls, request } = vercel(json({ id: "prj_1", name: "openorc-brain", extra: true }));
    expect(await ensureVercelProject(TOKEN, "team_1", "openorc-brain", request)).toEqual({ id: "prj_1", name: "openorc-brain" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.vercel.com/v9/projects/openorc-brain?teamId=team_1");
    expect(calls[0]!.init.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
  });

  it("makes the project on the team when Vercel has none", async () => {
    const { calls, request } = vercel(json({ error: { message: "Project not found." } }, 404), json({ id: "prj_2", name: "openorc-brain" }));
    expect(await ensureVercelProject(TOKEN, "team_1", "openorc-brain", request)).toEqual({ id: "prj_2", name: "openorc-brain" });
    expect(calls[1]!.url).toBe("https://api.vercel.com/v11/projects?teamId=team_1");
    expect(calls[1]!.init).toMatchObject({ method: "POST", body: JSON.stringify({ name: "openorc-brain" }) });
  });

  it("fails with Vercel's own words, never the token", async () => {
    const refused = vercel(json({ error: { message: "You don't have permission." } }, 403));
    await expect(ensureVercelProject(TOKEN, "team_1", "openorc-brain", refused.request)).rejects.toThrow("You don't have permission.");
    expect(refused.calls).toHaveLength(1);

    const unmade = vercel(new Response(null, { status: 404 }), new Response(`token ${TOKEN} rejected`, { status: 400 }));
    const error = await ensureVercelProject(TOKEN, "team_1", "openorc-brain", unmade.request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Could not make the openorc-brain project: Vercel answered 400.");
  });

  it("only looks when asked to find one: null for a team without it", async () => {
    const { calls, request } = vercel(json({ error: { message: "Project not found." } }, 404));
    expect(await findVercelProject(TOKEN, "team_1", "openorc-brain", request)).toBeNull();
    expect(calls.map((call) => call.init.method)).toEqual(["GET"]);
  });
});
