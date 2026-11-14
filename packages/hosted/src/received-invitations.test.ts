import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted, type HostedDeps } from "./index.js";
import { hostDeps, newDevice, signInAs } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const ADMIN = "alex@example.com";
const RECIPIENT = "mira@example.com";
let stand: StandIn;
let spaceId: string;
let now: number;
const hosts: Hosted[] = [];
beforeEach(async () => {
  now = Date.now();
  stand = await standIn({ signup: "open", now: () => now });
  spaceId = stand.addTeam("Birch Studio", [ADMIN]);
});
afterEach(async () => {
  hosts.splice(0).forEach((host) => host.close());
  await stand.close();
});
async function person(email: string, overrides: Partial<HostedDeps> = {}) {
  const { deps, browser, seen } = hostDeps(stand, newDevice(), { now: () => now, ...overrides });
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, email);
  await vi.waitFor(() => expect(hosted.spaces.status().state).toBe("ready"));
  return { hosted, seen };
}
const invite = () => stand.organizations.invite(spaceId, RECIPIENT, ADMIN);

it("delivers to an already connected recipient only, then joins readable projects and membership rooms", async () => {
  const { hosted: member, seen } = await person(RECIPIENT);
  const { hosted: admin } = await person(ADMIN);
  const projectId = stand.addProject(ADMIN, { name: "Canvas", fullName: "example/canvas" }, spaceId);
  const id = invite();
  await vi.waitFor(() => expect(member.spaces.status()).toMatchObject({ invitations: [{ id }] }));
  expect(admin.spaces.status()).toMatchObject({ invitations: [] });
  await expect(admin.spaces.received.accept(id)).rejects.toThrow("This invitation is for another email address.");
  expect(await member.spaces.received.accept(id)).toEqual({ spaceId });
  expect(member.spaces.status()).toMatchObject({ spaces: expect.arrayContaining([expect.objectContaining({ id: spaceId, role: "member" })]), invitations: [] });
  expect(await member.spaces.projects(spaceId)).toEqual([expect.objectContaining({ hostedProjectId: projectId })]);
  const threadId = stand.addThread(ADMIN, { projectId, title: "Review the cache" });
  await vi.waitFor(() => expect(member.threads.holds({ thread: threadId })).toBe(true));
  expect((await member.spaces.people(spaceId)).members).toEqual((await admin.spaces.people(spaceId)).members);
  expect(seen.pushes).toContainEqual({ type: "invalidate", keys: [`people:${spaceId}`, `invitations:${spaceId}`] });
});

it("declines without membership, and an accepted or revoked invitation cannot be acted on again", async () => {
  const { hosted } = await person(RECIPIENT);
  const id = invite();
  expect(await hosted.spaces.received.decline(id)).toEqual({});
  expect(stand.spaces.member(spaceId, RECIPIENT)).toBeUndefined();
  await expect(hosted.spaces.received.accept(id)).rejects.toThrow("This invitation is no longer available.");
  const accepted = invite();
  await hosted.spaces.received.accept(accepted);
  await expect(hosted.spaces.received.decline(accepted)).rejects.toThrow("This invitation is no longer available.");
  await expect(hosted.spaces.received.accept(accepted)).rejects.toThrow("This invitation is no longer available.");
  stand.spaces.removeMember(spaceId, RECIPIENT);
  const revoked = invite();
  const { hosted: admin } = await person(ADMIN);
  await admin.spaces.invitations.revoke({ spaceId, invitationId: revoked });
  await expect(hosted.spaces.received.accept(revoked)).rejects.toThrow("This invitation is no longer available.");
});

it("drops expired inbox rows at their deadline and preserves the authenticated reject rule", async () => {
  const { hosted, seen } = await person(RECIPIENT);
  const id = invite();
  stand.organizations.received.find((row) => row.id === id)!.expiresAt = now + 25;
  await hosted.spaces.refresh();
  seen.pushes.length = 0;
  now += 30;
  await vi.waitFor(() => expect(seen.pushes).toContainEqual({ type: "invalidate", keys: ["spaces", "projects"] }));
  expect(hosted.spaces.status()).toMatchObject({ invitations: [] });
  await expect(hosted.spaces.received.accept(id)).rejects.toThrow("This invitation is no longer available.");
  expect(await hosted.spaces.received.decline(id)).toEqual({});
});

it("keeps acceptance recipient-bound through stale membership and inviter changes", async () => {
  const { hosted } = await person(RECIPIENT);
  const id = invite();
  stand.spaces.removeMember(spaceId, ADMIN);
  expect(await hosted.spaces.received.accept(id)).toEqual({ spaceId });
  const duplicate = invite();
  await expect(hosted.spaces.received.accept(duplicate)).rejects.toThrow("That person is already in this organization.");
  expect(await hosted.spaces.received.decline(duplicate)).toEqual({});
  expect(stand.spaces.member(spaceId, RECIPIENT)).toBeDefined();
});

it("reconciles membership accepted elsewhere and missed invitations after reconnect without an accept call", async () => {
  const { hosted } = await person(RECIPIENT);
  const { hosted: other } = await person(RECIPIENT);
  const id = invite();
  await other.spaces.received.accept(id);
  await vi.waitFor(() => expect(hosted.spaces.status()).toMatchObject({ spaces: expect.arrayContaining([expect.objectContaining({ id: spaceId })]), invitations: [] }));
  const elsewhere = stand.addTeam("Cedar Studio", [ADMIN]);
  await stand.down();
  const missed = stand.organizations.invite(elsewhere, RECIPIENT, ADMIN);
  await stand.up();
  hosted.awoke();
  await vi.waitFor(() => expect(hosted.spaces.status()).toMatchObject({ invitations: [{ id: missed }] }));
  expect(stand.requests.filter((request) => request.path.endsWith("accept-invitation"))).toHaveLength(1);
});

it("does not leak a late successful join into a signed-out account", async () => {
  let release: (() => void) | undefined;
  const { hosted } = await person(RECIPIENT, {
    fetch: async (url, init) => {
      const answer = await fetch(url, init);
      if (String(url).endsWith("accept-invitation"))
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return answer;
    },
  });
  const pending = hosted.spaces.received.accept(invite());
  const refused = expect(pending).rejects.toThrow("Your OpenOrc session changed. Try again.");
  await vi.waitFor(() => expect(release).toBeDefined());
  await hosted.account.signOut();
  release!();
  await refused;
  expect(hosted.spaces.status()).toEqual({ state: "signed-out" });
});

it("announces effective Pro to People in every team while keeping billing private", async () => {
  const { hosted: admin, seen } = await person(ADMIN);
  const { hosted: member } = await person(RECIPIENT);
  await member.spaces.received.accept(invite());
  const elsewhere = stand.addTeam("Cedar Studio", [ADMIN, RECIPIENT]);
  seen.pushes.length = 0;
  await member.account.openBilling({ page: "pro", period: "monthly" });
  stand.pay(RECIPIENT);
  for (const target of [spaceId, elsewhere]) {
    await vi.waitFor(() => expect(seen.pushes).toContainEqual({ type: "invalidate", keys: [`people:${target}`] }));
    const person = (await admin.spaces.people(target)).members.find((person) => person.email === RECIPIENT)!;
    expect(person.plan).toBe("pro");
    expect(Object.keys(person).sort()).toEqual(["email", "image", "joinedAt", "memberId", "name", "plan", "role", "userId"]);
  }
  expect(admin.account.status()).toMatchObject({ plan: { pro: false } });
  stand.setBilling(RECIPIENT, { pro: true, standing: "ending", at: new Date(now + 1000).toISOString(), monthlyLeftSeconds: 50, packsLeftSeconds: 0 });
  expect((await admin.spaces.people(spaceId)).members.find((person) => person.email === RECIPIENT)!.plan).toBe("pro");
  now += 1001;
  stand.organizations.planChanged(RECIPIENT);
  expect((await admin.spaces.people(spaceId)).members.find((person) => person.email === RECIPIENT)!.plan).toBe("free");
});
