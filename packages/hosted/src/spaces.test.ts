import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isSuperseded } from "@openorc/protocol";
import { createHosted, type Hosted, type HostedDeps } from "./index.js";
import { hostDeps, newDevice, signInAs, type Device } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";
import { wireInvitation, wireMembership, wireOrganization } from "./wire-spaces.js";

const ADMIN = "admin@example.com";
const MEMBER = "member@example.com";
let stand: StandIn;
let device: Device;
const hosts: Hosted[] = [];
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  device = newDevice();
});
afterEach(async () => {
  for (const host of hosts.splice(0)) host.close();
  await stand.close();
});

async function host(email = ADMIN, overrides: Partial<HostedDeps> = {}) {
  const { deps, browser, seen } = hostDeps(stand, device, overrides);
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, email);
  await vi.waitFor(() => expect(hosted.spaces.status().state).toBe("ready"));
  return { hosted, browser, seen };
}

it("reads spaces, a recipient-only inbox and strict millisecond DTOs over HTTP", async () => {
  const joined = stand.addTeam("Birch Studio", [ADMIN, MEMBER]);
  const invited = stand.addTeam("Cedar Studio", [MEMBER]);
  const invitationId = stand.organizations.invite(invited, ADMIN, MEMBER);
  stand.organizations.invite(joined, "other@example.com", ADMIN);
  const { hosted } = await host();
  expect(hosted.spaces.status()).toMatchObject({
    state: "ready",
    userId: `user-${ADMIN}`,
    create: { allowed: true, reason: null },
    spaces: [{ kind: "personal" }, { id: joined, role: "admin", memberCount: 2 }],
    invitations: [{ id: invitationId, expiresAt: expect.any(Number), organization: { id: invited } }],
  });
  expect(stand.requests.filter((request) => ["/spaces", "/invitations/received"].includes(request.path)).every((request) => request.authorized)).toBe(true);
});

it("reads People in the explicit space, not the personal session default, with plans for members", async () => {
  const a = stand.addTeam("Birch Studio", [ADMIN, MEMBER]);
  const b = stand.addTeam("Cedar Studio", [MEMBER, ADMIN]);
  stand.setBilling(ADMIN, { pro: true, standing: "live", at: new Date(Date.now() + 86_400_000).toISOString(), monthlyLeftSeconds: 500, packsLeftSeconds: 0 });
  const { hosted } = await host();
  expect(await hosted.spaces.people(b)).toMatchObject({
    organization: { id: b },
    viewer: { role: "member" },
    total: 2,
    adminCount: 1,
    members: expect.arrayContaining([expect.objectContaining({ email: ADMIN, plan: "pro", joinedAt: expect.any(Number) })]),
  });
  expect(await hosted.spaces.people(a, 0, 1)).toMatchObject({ viewer: { role: "admin" }, total: 2, members: [expect.any(Object)] });
  await expect(hosted.spaces.people(`personal-${ADMIN}`)).rejects.toThrow("Your personal space is yours alone, so it has no people to list.");
  await expect(hosted.spaces.people("not-a-membership")).rejects.toThrow("You're not in this organization.");
  expect(hosted.account.status().state).toBe("signed-in");
});

it("reports the lifetime creation limit independently from current memberships", async () => {
  stand.organizations.created.set(ADMIN, 5);
  const { hosted } = await host();
  expect(hosted.spaces.status()).toMatchObject({ create: { allowed: false, reason: "You've made 5 organizations, the most one person can." } });
});

it("lists every folder in Personal, and in an organization those of its projects, each paired with that space's own", async () => {
  const organization = stand.addTeam("Birch Studio", [ADMIN]);
  const team = stand.addProject(ADMIN, { name: "Canvas", fullName: "example/canvas" }, organization);
  const personal = stand.addProject(ADMIN, { name: "Canvas", fullName: "example/canvas" });
  const cloudOnly = stand.addProject(ADMIN, { name: "Tools", fullName: "example/tools" }, organization);
  device.projects = [
    { id: "copy-a", remote: "git@github.com:example/canvas.git" },
    { id: "copy-b", remote: "https://github.com/example/canvas" },
    { id: "notes", remote: null },
  ];
  const { hosted } = await host();
  expect(await hosted.spaces.projects(organization)).toMatchObject([
    { key: "copy-a", hostedProjectId: team },
    { key: "copy-b", hostedProjectId: team },
    { key: `openorc-cloud:${cloudOnly}`, localProjectId: null },
  ]);
  expect(await hosted.spaces.projects(`personal-${ADMIN}`)).toMatchObject([
    { key: "copy-a", hostedProjectId: personal },
    { key: "copy-b", hostedProjectId: personal },
    { key: "notes", hostedProjectId: null },
  ]);
});

it("retains other spaces when access to one disappears between the index and project reads", async () => {
  const removed = stand.addTeam("Birch Studio", [MEMBER, ADMIN]);
  const kept = stand.addTeam("Cedar Studio", [ADMIN]);
  const project = stand.addProject(ADMIN, { name: "Tools", fullName: "example/tools" }, kept);
  const { hosted } = await host(ADMIN, {
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (new URL(String(input)).pathname === "/spaces") stand.spaces.removeMember(removed, ADMIN);
      return response;
    },
  });
  expect(await hosted.spaces.projects(kept)).toMatchObject([{ hostedProjectId: project }]);
  hosted.awoke();
  await vi.waitFor(() => {
    const status = hosted.spaces.status();
    expect(status.state === "ready" && status.spaces.some((space) => space.id === removed)).toBe(false);
  });
  await expect(hosted.spaces.projects(removed)).rejects.toThrow("You're not in this organization.");
});

it("retains cached space facts on an outage and clears them on sign-out", async () => {
  const organization = stand.addTeam("Birch Studio", [ADMIN]);
  const { hosted } = await host();
  expect(device.spaces).toContain(stand.url);
  expect(device.spaces).toContain(`user-${ADMIN}`);
  expect(device.spaces).not.toContain("invitations");
  await stand.down();
  hosted.awoke();
  await vi.waitFor(() =>
    expect(hosted.spaces.status()).toMatchObject({ state: "ready", error: "OpenOrc Cloud can't be reached.", spaces: expect.arrayContaining([expect.objectContaining({ id: organization })]) }),
  );
  await hosted.account.signOut();
  expect(hosted.spaces.status()).toEqual({ state: "signed-out" });
  expect(device.spaces).toBeNull();
});

it("answers a space read asked after sign-out as superseded, and one for a space the person isn't in as refused", async () => {
  const organization = stand.addTeam("Birch Studio", [ADMIN]);
  const { hosted } = await host();
  await expect(hosted.spaces.projects("elsewhere")).rejects.toThrow("You're not in this organization.");
  await hosted.account.signOut();
  await expect(hosted.spaces.projects(organization)).rejects.toSatisfy(isSuperseded);
});

it("discards a late roster response after signing in as a different account", async () => {
  const organization = stand.addTeam("Birch Studio", [ADMIN]);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { hosted, browser } = await host(ADMIN, {
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (new URL(String(input)).pathname === "/organization/people") await gate;
      return response;
    },
  });
  const pending = hosted.spaces.people(organization);
  await vi.waitFor(() => expect(stand.requests.some((request) => request.path === "/organization/people")).toBe(true));
  await hosted.account.signOut();
  await signInAs(hosted, browser, MEMBER);
  const refused = expect(pending).rejects.toThrow("Your OpenOrc session changed.");
  release?.();
  await refused;
  await vi.waitFor(() => expect(hosted.spaces.status()).toMatchObject({ state: "ready", userId: `user-${MEMBER}`, spaces: [{ kind: "personal" }] }));
});

it("normalizes omitted Better Auth logo fields and parses bare membership and invitation records", () => {
  const createdAt = new Date(0).toISOString();
  expect(wireOrganization.parse({ id: "org", name: "Birch Studio", slug: "birch", createdAt, members: [] })).toMatchObject({ logo: null, personalOf: null });
  expect(wireMembership.parse({ id: "member", userId: "person", organizationId: "org", role: "member", createdAt }).id).toBe("member");
  expect(wireInvitation.parse({ id: "invite", organizationId: "org", inviterId: "person", email: MEMBER, role: null, status: "pending", expiresAt: createdAt, createdAt }).role).toBeNull();
  expect(wireMembership.safeParse({ member: { id: "member" } }).success).toBe(false);
});

it("refreshes newly joined spaces on thread events while the inbox route is unavailable", async () => {
  const { hosted } = await host(ADMIN, {
    fetch: (input, init) => {
      if (new URL(String(input)).pathname === "/invitations/received") return Promise.resolve(new Response(JSON.stringify({ message: "Not found" }), { status: 404 }));
      return fetch(input, init);
    },
  });
  const space = stand.addTeam("Birch Studio", [ADMIN]);
  const project = stand.addProject(ADMIN, { name: "Canvas", fullName: "example/canvas" }, space);
  const thread = stand.addThread(ADMIN, { projectId: project, title: "New work" });
  await vi.waitFor(() => expect(hosted.threads.holds({ thread })).toBe(true));
  expect(await hosted.spaces.projects(space)).toMatchObject([{ hostedProjectId: project }]);
  expect(hosted.spaces.status()).toMatchObject({ state: "ready", error: "Not found" });
});
