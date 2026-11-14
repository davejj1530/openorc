import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted, type HostedDeps } from "./index.js";
import { hostDeps, newDevice, signInAs, testBrowser } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const ADMIN = "alex@example.com";
const MEMBER = "mira@example.com";
let stand: StandIn;
let now: number;
let spaceId: string;
const hosts: Hosted[] = [];
beforeEach(async () => {
  now = Date.now();
  stand = await standIn({ signup: "open", now: () => now });
  spaceId = stand.addTeam("Birch Studio", [ADMIN, MEMBER]);
});
afterEach(async () => {
  hosts.splice(0).forEach((host) => host.close());
  await stand.close();
});
async function person(email = ADMIN, overrides: Partial<HostedDeps> = {}) {
  const browser = testBrowser(stand);
  const { deps } = hostDeps(stand, newDevice(), { browser, now: () => now, ...overrides });
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, email);
  await vi.waitFor(() => expect(hosted.spaces.status().state).toBe("ready"));
  return hosted;
}
const send = (hosted: Hosted, emails: string[], target = spaceId) => hosted.spaces.invitations.send({ spaceId: target, emails, role: "member" });

it("normalizes addresses, distinguishes existing membership from invitations, and reads delivery before reporting success", async () => {
  const hosted = await person();
  const existing = stand.organizations.invite(spaceId, "jules@example.com", ADMIN);
  stand.organizations.invitations.delivery.set("tess@example.com", { status: "failed", reason: "The mail service refused this address." });
  stand.organizations.invitations.delivery.set("lee@example.com", { status: "logged", reason: null });
  const result = await send(hosted, [" TESS@example.com ", "tess@example.com", "jules@example.com", MEMBER, "lee@example.com", "invalid@"]);
  expect(result.map(({ email, state }) => [email, state])).toEqual([
    ["tess@example.com", "sent"],
    ["jules@example.com", "already-invited"],
    [MEMBER, "already-member"],
    ["lee@example.com", "sent"],
    ["invalid@", "refused"],
  ]);
  expect(result[0]).toMatchObject({
    invitation: { delivery: { status: "failed", reason: "The mail service refused this address." }, url: expect.stringMatching(/^https:\/\/app.example.com\/invite\//), resendAt: now + 600_000 },
  });
  expect(result[3]).toMatchObject({ invitation: { delivery: { status: "logged" } } });
  expect(stand.organizations.invitations.ledger).toHaveLength(2);
  expect((await hosted.spaces.invitations.list(spaceId)).some((invite) => invite.id === existing)).toBe(true);
});

it("keeps an admitted invitation successful when its delivery read fails, without retrying creation", async () => {
  let fail = false;
  let posts = 0;
  const hosted = await person(ADMIN, {
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("invite-member")) {
        posts++;
        fail = true;
      }
      if (fail && path === "/invitations") throw new Error("offline");
      return fetch(url, init);
    },
  });
  const results = await send(hosted, ["jules@example.com"]);
  expect(results[0]).toMatchObject({ state: "sent", invitation: null, error: "OpenOrc Cloud can't be reached." });
  expect(posts).toBe(1);
  expect(stand.organizations.received).toHaveLength(1);
});

it("reuses expired invitations on explicit resend and obeys the authoritative cooldown", async () => {
  const hosted = await person();
  await send(hosted, ["jules@example.com"]);
  const [invite] = await hosted.spaces.invitations.list(spaceId);
  const input = { spaceId, invitationId: invite!.id };
  await expect(hosted.spaces.invitations.resend(input)).rejects.toThrow("That invite just went out. Send it again in 10 minutes.");
  now += 8 * 86_400_000;
  expect((await hosted.spaces.invitations.list(spaceId))[0]!.state).toBe("expired");
  const resent = await hosted.spaces.invitations.resend(input);
  expect(resent).toMatchObject({ id: invite!.id, state: "pending", expiresAt: now + 7 * 86_400_000, resendAt: now + 600_000 });
  expect(stand.organizations.invitations.ledger).toHaveLength(2);
});

it("returns the server's current invitation when an older expired address was invited anew", async () => {
  const hosted = await person();
  await send(hosted, ["jules@example.com"]);
  const [old] = await hosted.spaces.invitations.list(spaceId);
  now += 8 * 86_400_000;
  await send(hosted, ["jules@example.com"]);
  const current = (await hosted.spaces.invitations.list(spaceId)).find((invite) => invite.id !== old!.id)!;
  now += 600_000;
  expect((await hosted.spaces.invitations.resend({ spaceId, invitationId: old!.id })).id).toBe(current.id);
  expect((await hosted.spaces.invitations.list(spaceId)).find((invite) => invite.id === old!.id)!.state).toBe("expired");
});

it("scopes management to admins and reconciles revoked invitations and demotion elsewhere", async () => {
  const hosted = await person();
  const member = await person(MEMBER);
  await send(hosted, ["jules@example.com"]);
  const [invite] = await hosted.spaces.invitations.list(spaceId);
  const input = { spaceId, invitationId: invite!.id };
  await expect(member.spaces.invitations.list(spaceId)).rejects.toThrow("Only an admin can do that.");
  await expect(member.spaces.invitations.resend(input)).rejects.toThrow("Only an admin can do that.");
  const elsewhere = stand.addTeam("Cedar Studio", [ADMIN]);
  await expect(hosted.spaces.invitations.revoke({ ...input, spaceId: elsewhere })).rejects.toThrow("This invitation is no longer available.");
  await hosted.spaces.invitations.revoke(input);
  expect(await hosted.spaces.invitations.list(spaceId)).toEqual([]);
  await expect(hosted.spaces.invitations.resend(input)).rejects.toThrow("This invitation is no longer available.");
  stand.spaces.member(spaceId, ADMIN)!.role = "member";
  expect(await send(hosted, ["tess@example.com"])).toEqual([{ email: "tess@example.com", state: "refused", error: "Only an admin can do that." }]);
});

it("enforces rolling limits across organizations and inviters without consuming allowance on duplicate refusals", async () => {
  const hosted = await person();
  const other = await person(MEMBER);
  stand.spaces.member(spaceId, MEMBER)!.role = "admin";
  const elsewhere = stand.addTeam("Cedar Studio", [ADMIN]);
  await send(hosted, [MEMBER, "invalid@"]);
  expect(stand.organizations.invitations.ledger).toHaveLength(0);
  expect(
    (
      await send(
        hosted,
        Array.from({ length: 20 }, (_, i) => `person${i}@example.com`),
      )
    ).every((result) => result.state === "sent"),
  ).toBe(true);
  expect((await send(hosted, ["next@example.com"], elsewhere))[0]).toMatchObject({ state: "refused", error: "You've sent 20 invitations in the past 24 hours. Try again later." });
  await send(
    other,
    Array.from({ length: 10 }, (_, i) => `other${i}@example.com`),
  );
  expect((await send(other, ["next@example.com"]))[0]).toMatchObject({ state: "refused", error: "Birch Studio has sent 30 invitations in the past 24 hours. Try again later." });
  now += 86_400_001;
  expect((await send(hosted, ["next@example.com"]))[0]!.state).toBe("sent");
});

it("discards a reply and stops the remaining batch when the account signs out", async () => {
  let release: (() => void) | undefined;
  const hosted = await person(ADMIN, {
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (new URL(String(url)).pathname.endsWith("invite-member"))
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return response;
    },
  });
  const pending = send(hosted, ["jules@example.com", "tess@example.com"]);
  const failed = expect(pending).rejects.toThrow("Your OpenOrc session changed. Try again.");
  await vi.waitFor(() => expect(release).toBeDefined());
  await hosted.account.signOut();
  release!();
  await failed;
  expect(stand.organizations.received.map((invite) => invite.email)).toEqual(["jules@example.com"]);
});
