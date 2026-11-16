import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { hostDeps, newDevice, signInAs } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const ADA = "ada@example.com";
const BEN = "ben@example.com";
const ON = { projectEnvironment: { available: true } } as const;

let stand: StandIn;
let now = Date.now();
const hosts: Hosted[] = [];

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
});

afterEach(async () => {
  for (const hosted of hosts.splice(0)) hosted.close();
  await stand.close();
});

async function signedIn(email: string) {
  const { deps, browser } = hostDeps(stand, newDevice(), { now: () => now });
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, email);
  return hosted;
}

/** A team of Ada (its admin) and Ben, with one project everyone uses. */
function team() {
  const space = stand.addTeam("Example team", [ADA, BEN]);
  const project = stand.addProject(ADA, { name: "api", fullName: "example/api" }, space);
  return { space, project };
}

describe("a cloud project's environment", () => {
  it("reads as unavailable behind the server's switch, and from a server that has no such route", async () => {
    const { space, project } = team();
    const ada = await signedIn(ADA);
    stand.threadFiles.capabilities = { projectEnvironment: { available: false, reason: "A project's environment isn't available in cloud threads yet." } };
    expect(await ada.environment.read(space, project)).toEqual({ state: "unavailable" });
    stand.threadFiles.capabilities = null;
    expect(await ada.environment.read(space, project)).toEqual({ state: "unavailable" });
  });

  it("saves values an admin sets, reads back names and times only, and removes one by name", async () => {
    const { space, project } = team();
    stand.threadFiles.capabilities = ON;
    const ada = await signedIn(ADA);
    expect(await ada.environment.read(space, project)).toEqual({ state: "ready", variables: [], canChange: true });
    const saved = await ada.environment.set(space, project, [
      { name: "DATABASE_URL", value: "postgres://localhost/app" },
      { name: "APP_MODE", value: "dev" },
    ]);
    expect(saved).toMatchObject({ state: "saved", canChange: true, variables: [{ name: "APP_MODE" }, { name: "DATABASE_URL" }] });
    expect(saved.state === "saved" && saved.variables.every((variable) => Number.isFinite(variable.updatedAt))).toBe(true);
    expect(JSON.stringify(await ada.environment.read(space, project))).not.toContain("postgres");
    expect(stand.environment.values(project)).toEqual({ DATABASE_URL: "postgres://localhost/app", APP_MODE: "dev" });
    expect(await ada.environment.remove(space, project, "APP_MODE")).toMatchObject({ state: "ready", variables: [{ name: "DATABASE_URL" }] });
  });

  it("answers a refused name with the server's sentence for that name, and keeps nothing of the save", async () => {
    const { space, project } = team();
    stand.threadFiles.capabilities = ON;
    const ada = await signedIn(ADA);
    const refused = await ada.environment.set(space, project, [
      { name: "APP_MODE", value: "dev" },
      { name: "ANTHROPIC_API_KEY", value: "x" },
    ]);
    expect(refused).toEqual({ state: "refused", name: "ANTHROPIC_API_KEY", message: "ANTHROPIC_ names are kept for the agents." });
    expect(stand.environment.values(project)).toEqual({});
  });

  it("lets a member read the names and refuses their change in the server's words", async () => {
    const { space, project } = team();
    stand.threadFiles.capabilities = ON;
    const ada = await signedIn(ADA);
    await ada.environment.set(space, project, [{ name: "DATABASE_URL", value: "postgres://localhost/app" }]);
    const ben = await signedIn(BEN);
    expect(await ben.environment.read(space, project)).toMatchObject({ state: "ready", canChange: false, variables: [{ name: "DATABASE_URL" }] });
    await expect(ben.environment.set(space, project, [{ name: "MINE", value: "x" }])).rejects.toThrow("Only an admin can change a project's environment.");
  });

  it("fails as a failure when the server can't be reached, never as no variables", async () => {
    const { space, project } = team();
    stand.threadFiles.capabilities = ON;
    const ada = await signedIn(ADA);
    await stand.down();
    await expect(ada.environment.read(space, project)).rejects.toThrow();
    await stand.up();
  });
});

describe("whether a space's server keeps projects' environments", () => {
  it("asks once a session where it does, and again after a minute where it does not", async () => {
    const { space } = team();
    const ada = await signedIn(ADA);
    const asked = () => stand.requests.filter((request) => request.path === "/hosted/capabilities").length;
    stand.threadFiles.capabilities = { projectEnvironment: { available: false, reason: "A project's environment isn't available in cloud threads yet." } };
    expect(await ada.environment.available(space)).toBe(false);
    expect(await ada.environment.available(space)).toBe(false);
    expect(asked()).toBe(1);
    stand.threadFiles.capabilities = ON;
    now += 61_000;
    expect(await ada.environment.available(space)).toBe(true);
    expect(await ada.environment.available(space)).toBe(true);
    expect(asked()).toBe(2);
  });

  it("is not kept by a server with no capabilities at all", async () => {
    const { space } = team();
    stand.threadFiles.capabilities = null;
    const ada = await signedIn(ADA);
    expect(await ada.environment.available(space)).toBe(false);
  });
});
