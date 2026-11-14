import { afterEach, beforeEach, expect, it, vi } from "vitest";
import sharp from "sharp";
import { createHosted, type Hosted, type HostedDeps } from "./index.js";
import { hostDeps, newDevice, signInAs, testBrowser } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const ADMIN = "admin@example.com";
let logo: string;
let stand: StandIn;
const hosts: Hosted[] = [];
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  logo = `data:image/png;base64,${(
    await sharp({ create: { width: 128, height: 128, channels: 3, background: "#445566" } })
      .png()
      .toBuffer()
  ).toString("base64")}`;
});
afterEach(async () => {
  hosts.splice(0).forEach((host) => host.close());
  await stand.close();
});
async function host(overrides: Partial<HostedDeps> = {}) {
  const browser = testBrowser(stand, (url, self) => self.back(stand.github.returnFor(url)));
  const { deps } = hostDeps(stand, newDevice(), { browser, ...overrides });
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, ADMIN);
  await vi.waitFor(() => expect(hosted.spaces.status().state).toBe("ready"));
  return hosted;
}

it("creates once on simultaneous submit, then edits the explicit organization without affecting another", async () => {
  const other = stand.addTeam("Cedar Studio", [ADMIN]);
  const hosted = await host();
  const a = hosted.spaces.setup.create({ name: "  Birch   Studio  ", logo });
  const b = hosted.spaces.setup.create({ name: "  Birch   Studio  ", logo });
  expect(await a).toEqual(await b);
  const { spaceId } = await a;
  expect(stand.organizations.created.get(ADMIN)).toBe(1);
  expect(stand.spaces.teams.get(spaceId)?.logo).toMatch(/^data:image\/webp;base64,/);
  expect(await hosted.spaces.setup.update({ spaceId, name: "Birch Works", logo: null })).toEqual({ id: spaceId, name: "Birch Works", logo: null });
  expect(stand.spaces.teams.get(other)?.name).toBe("Cedar Studio");
  await expect(hosted.spaces.setup.create({ name: "  " })).rejects.toThrow("Give the organization a name.");
  await expect(hosted.spaces.setup.create({ name: "OpenOrc Support" })).rejects.toThrow("That name is reserved.");
  expect(stand.organizations.created.get(ADMIN)).toBe(1);
});

it("returns a created organization when the logo fails and retries only its logo", async () => {
  let fail = true;
  const hosted = await host({
    fetch: (input, init) =>
      new URL(String(input)).pathname === "/settings/organization" && fail
        ? Promise.resolve(new Response(JSON.stringify({ message: "That picture couldn't be read. Pick another PNG, JPEG or WebP." }), { status: 400 }))
        : fetch(input, init),
  });
  const result = await hosted.spaces.setup.create({ name: "Birch Studio", logo });
  expect(result.logoError).toContain("That picture couldn't be read.");
  expect(hosted.spaces.status()).toMatchObject({ spaces: expect.arrayContaining([expect.objectContaining({ id: result.spaceId })]) });
  fail = false;
  await hosted.spaces.setup.update({ spaceId: result.spaceId, logo });
  expect(stand.organizations.created.get(ADMIN)).toBe(1);
  expect(stand.requests.filter((request) => request.path === "/api/auth/organization/create")).toHaveLength(1);
});

it("refuses unnormalized or unreadable rasters without applying a name change", async () => {
  const hosted = await host();
  const { spaceId } = await hosted.spaces.setup.create({ name: "Birch Studio", logo });
  const small = `data:image/png;base64,${(
    await sharp({ create: { width: 2, height: 2, channels: 3, background: "#445566" } })
      .png()
      .toBuffer()
  ).toString("base64")}`;
  await expect(hosted.spaces.setup.update({ spaceId, name: "Changed", logo: small })).rejects.toThrow("That picture couldn't be read.");
  await expect(hosted.spaces.setup.update({ spaceId, logo: "data:image/webp;base64,UklGRg==" })).rejects.toThrow("That file isn't the picture it says it is.");
  expect(stand.spaces.teams.get(spaceId)?.name).toBe("Birch Studio");
});

it("reconciles a lost create response before an explicit retry without making another organization", async () => {
  let lose = true;
  const hosted = await host({
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (new URL(String(input)).pathname === "/api/auth/organization/create" && lose) {
        lose = false;
        throw new Error("Lost reply");
      }
      return response;
    },
  });
  await expect(hosted.spaces.setup.create({ name: "Birch Studio" })).rejects.toThrow("can't be reached");
  const result = await hosted.spaces.setup.create({ name: "Birch Studio" });
  expect(stand.spaces.teams.get(result.spaceId)?.name).toBe("Birch Studio");
  expect(stand.requests.filter((request) => request.path === "/api/auth/organization/create")).toHaveLength(1);
});

it("binds GitHub and per-repository outcomes to the organization across the browser return", async () => {
  const organization = stand.addTeam("Birch Studio", [ADMIN]);
  const other = stand.addTeam("Cedar Studio", [ADMIN]);
  stand.github.grant(ADMIN, ["example/canvas", "example/tools"]);
  const hosted = await host();
  await hosted.spaces.setup.connect(organization);
  await vi.waitFor(async () => expect((await hosted.spaces.setup.repositories(organization)).repositories).toHaveLength(2));
  expect((await hosted.spaces.setup.repositories(other)).repositories).toEqual([]);
  const read = await hosted.spaces.setup.repositories(organization);
  const first = read.repositories[0]!;
  const outcomes = await hosted.spaces.setup.addProjects({ spaceId: organization, repositories: [first, { ...first, repoId: 99999 }] });
  expect(outcomes).toMatchObject([{ state: "added" }, { state: "refused", error: "OpenOrc can't read that repository. Check the app's access on GitHub." }]);
  expect(await hosted.spaces.projects(organization)).toMatchObject([{ key: expect.stringMatching(/^openorc-cloud:/), localProjectId: null }]);
  expect(await hosted.spaces.projects(other)).toEqual([]);
  await hosted.spaces.setup.connect(other);
  const connected = await hosted.spaces.setup.repositories(other);
  expect(connected.connecting).toBeNull();
  expect(connected.repositories).toHaveLength(2);
  expect(connected.installations[0]?.id).not.toBe(read.installations[0]?.id);
  expect(connected.repositories.every((repository) => repository.projectId === null)).toBe(true);
  expect((await hosted.spaces.setup.repositories(organization)).repositories[0]?.projectId).toBeTruthy();
});

it("keeps member setup controls unauthorized at the HTTP boundary", async () => {
  const organization = stand.addTeam("Birch Studio", ["owner@example.com", ADMIN]);
  const hosted = await host();
  await expect(hosted.spaces.setup.update({ spaceId: organization, name: "Changed" })).rejects.toThrow("Only an admin can do that.");
  await expect(hosted.spaces.setup.repositories(organization)).rejects.toThrow("Only an admin can do that.");
  expect(await hosted.spaces.setup.addProjects({ spaceId: organization, repositories: [{ installationId: "one", repoId: 1 }] })).toEqual([
    { installationId: "one", repoId: 1, state: "refused", error: "Only an admin can do that." },
  ]);
});

it("accepts a GitHub install that the service settles as connected without opening another page", async () => {
  const spaceId = stand.addTeam("Birch Studio", [ADMIN]);
  const hosted = await host({
    fetch: (input, init) =>
      new URL(String(input)).pathname === "/github/install/start" ? Promise.resolve(new Response(JSON.stringify({ kind: "settled", outcome: "connected" }), { status: 200 })) : fetch(input, init),
  });
  expect((await hosted.spaces.setup.connect(spaceId)).connecting).toBeNull();
});

it("keeps another-account intent through linking and adds a second installation without replacing the first", async () => {
  const spaceId = stand.addTeam("Birch Studio", [ADMIN]);
  const other = stand.addTeam("Cedar Studio", [ADMIN]);
  stand.github.grant(ADMIN, ["birch/canvas"], { accountLogin: "birch", accountType: "Organization" });
  const starts: { body: unknown; space: string | null }[] = [];
  const hosted = await host({
    fetch: (input, init) => {
      if (new URL(String(input)).pathname === "/github/install/start") starts.push({ body: JSON.parse(String(init?.body)), space: new Headers(init?.headers).get("x-openorc-space") });
      return fetch(input, init);
    },
  });
  await hosted.spaces.setup.connect(spaceId, true);
  await vi.waitFor(async () => expect((await hosted.spaces.setup.repositories(spaceId)).installations).toHaveLength(1));
  expect(starts).toHaveLength(2);
  expect(starts).toEqual([1, 2].map(() => ({ body: { port: expect.any(Number), another: true }, space: spaceId })));
  const first = (await hosted.spaces.setup.repositories(spaceId)).repositories[0]!;
  await hosted.spaces.setup.addProjects({ spaceId, repositories: [first] });
  stand.github.grant(ADMIN, ["cedar/tools"], { id: 7002, accountLogin: "cedar", accountType: "Organization", settingsUrl: "https://github.com/organizations/cedar/settings/installations/7002" });
  await hosted.spaces.setup.connect(spaceId, true);
  await vi.waitFor(async () => expect((await hosted.spaces.setup.repositories(spaceId)).installations).toHaveLength(2));
  const data = await hosted.spaces.setup.repositories(spaceId);
  expect(data.installations.map(({ accountLogin, settingsUrl }) => ({ accountLogin, settingsUrl }))).toEqual([
    { accountLogin: "birch", settingsUrl: "https://github.com/settings/installations/7001" },
    { accountLogin: "cedar", settingsUrl: "https://github.com/organizations/cedar/settings/installations/7002" },
  ]);
  expect(data.repositories[0]?.projectId).toBeTruthy();
  expect(data.repositories.map((repository) => repository.fullName)).toEqual(["birch/canvas", "cedar/tools"]);
  expect((await hosted.spaces.setup.repositories(other)).installations).toEqual([]);
});

it("rereads new grants and unavailable settings without losing a connected account or added project", async () => {
  const spaceId = stand.addTeam("Birch Studio", [ADMIN]);
  stand.github.grant(ADMIN, ["birch/canvas"]);
  const hosted = await host();
  await hosted.spaces.setup.connect(spaceId);
  await vi.waitFor(async () => expect((await hosted.spaces.setup.repositories(spaceId)).repositories).toHaveLength(1));
  const first = (await hosted.spaces.setup.repositories(spaceId)).repositories[0]!;
  await hosted.spaces.setup.addProjects({ spaceId, repositories: [first] });
  stand.github.grant(ADMIN, ["birch/canvas", "birch/tools"], { settingsUrl: null });
  const data = await hosted.spaces.setup.repositories(spaceId);
  expect(data.installations).toMatchObject([{ id: first.installationId, settingsUrl: null }]);
  expect(data.repositories).toMatchObject([
    { ...first, projectId: expect.any(String) },
    { fullName: "birch/tools", projectId: null },
  ]);
  expect(stand.requests.filter((request) => request.path === "/github/install/finish")).toHaveLength(1);
});
