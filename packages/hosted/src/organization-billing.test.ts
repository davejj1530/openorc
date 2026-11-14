import type { SpacesStatus } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { OrganizationBilling } from "./organization-billing.js";
import type { WireOrganizationBilling } from "./organization-billing-wire.js";
import { OutOfReach, Refused, type SessionState } from "./session.js";
import type { Route } from "./wire.js";

const billing: WireOrganizationBilling = {
  organization: { id: "team-a", name: "Example team", logo: null },
  revision: "revision-a",
  asOf: "2026-11-01T00:00:00.000Z",
  subscription: null,
  seats: [],
  available: 0,
};
const services: OrganizationBilling[] = [];
afterEach(() => services.splice(0).forEach((service) => service.close()));

function fixture() {
  let status: SpacesStatus = {
    state: "ready",
    userId: "person-a",
    apiOrigin: "https://example.com",
    personalSpaceId: "personal",
    spaces: [
      { id: "personal", kind: "personal" },
      { id: "team-a", name: "Example team", logo: null, kind: "organization", role: "admin", memberId: "member-a", memberCount: 1 },
    ],
    create: { allowed: true, reason: null },
    invitations: [],
    reach: "live",
    heardAt: Date.now(),
    error: null,
  };
  let saved: string | null = null;
  const reply = vi.fn<(path: string, body: unknown, spaceId: string) => Promise<unknown>>(async (path) => (path === "/organization/billing" ? billing : { url: "https://example.com/checkout" }));
  const session = {
    state: { signedIn: true, email: "person@example.com", reach: "live" } satisfies SessionState,
    generation: 1,
    in: (spaceId: string) => ({
      request: async <T>(route: Route<T>, body?: unknown): Promise<T> => {
        const result = await reply(route.path, body, spaceId);
        if (!route.reply) throw new Error("Missing reply schema");
        return route.reply.parse(result);
      },
    }),
    onChange: vi.fn(),
    onSocket: vi.fn(),
  };
  const browser = { open: vi.fn(), awaitReturn: vi.fn() };
  const push = vi.fn();
  const service = new OrganizationBilling({
    session,
    spaces: { status: () => status, refresh: vi.fn(async () => {}) },
    storage: {
      load: () => saved,
      save: (value) => {
        saved = value;
      },
    },
    server: "https://example.com",
    now: Date.now,
    browser,
    push,
  });
  services.push(service);
  return {
    service,
    session,
    reply,
    browser,
    push,
    status: (next: SpacesStatus) => {
      status = next;
    },
    demote: () => {
      if (status.state === "ready") status = { ...status, spaces: status.spaces.map((space) => (space.kind === "organization" ? { ...space, role: "member" } : space)) };
    },
  };
}

it("uses the explicit organization and never returns private billing to a member or Personal", async () => {
  const f = fixture();
  expect((await f.service.get("team-a")).billing?.organization.id).toBe("team-a");
  expect(f.reply).toHaveBeenLastCalledWith("/organization/billing", undefined, "team-a");
  await expect(f.service.get("personal")).rejects.toThrow("personal space");
  f.demote();
  await expect(f.service.get("team-a")).rejects.toThrow("Only an admin");
  expect(f.reply).toHaveBeenCalledTimes(1);
});

it.each(["offers", "checkout"])("purges privileged snapshots when %s refuses stale admin rights", async (operation) => {
  const f = fixture();
  await f.service.get("team-a");
  f.reply.mockRejectedValueOnce(new Refused("Only an admin can do that.", 403));
  const refused = operation === "offers" ? f.service.offers("team-a", 3) : f.service.open("team-a", { page: "checkout", plan: "monthly", seats: 3 });
  await refused.catch(() => undefined);
  f.reply.mockRejectedValueOnce(new OutOfReach());
  expect((await f.service.get("team-a")).billing).toBeNull();
  expect(f.browser.open).not.toHaveBeenCalled();
});

it("does not restore an inventory response after the viewer is demoted", async () => {
  const f = fixture();
  let resolve: (value: unknown) => void = () => undefined;
  f.reply.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const reading = f.service.get("team-a");
  f.demote();
  resolve(billing);
  await expect(reading).rejects.toThrow("organization access changed");
});

it("keeps a confirmed read through a network error without fabricating capacity", async () => {
  const f = fixture();
  await f.service.get("team-a");
  f.reply.mockRejectedValueOnce(new OutOfReach());
  expect(await f.service.get("team-a")).toMatchObject({ billing: { available: 0 }, error: "OpenOrc Cloud can't be reached." });
});

it("refuses prices for a different count instead of applying them to the form", async () => {
  const f = fixture();
  f.reply.mockResolvedValueOnce({ offers: [{ plan: "monthly", seats: 2, price: { amount: 177, currency: "usd" } }], monthlySeconds: 360000, maxSeats: 100 });
  await expect(f.service.offers("team-a", 3)).rejects.toThrow("seat prices changed");
});

it("does not invalidate its own reads while external reconciliation notifies the screen", async () => {
  const f = fixture();
  await f.service.get("team-a");
  expect(f.push).not.toHaveBeenCalled();
  await f.service.awoke();
  expect(f.push).toHaveBeenCalledExactlyOnceWith({ type: "invalidate", keys: ["organization-billing:team-a"] });
});

it.each([401, 403, 404])("returns an empty private projection after HTTP %s before the roster catches up", async (status) => {
  const f = fixture();
  await f.service.get("team-a");
  await f.service.open("team-a", { page: "checkout", plan: "monthly", seats: 3 });
  f.push.mockClear();
  f.reply.mockRejectedValue(new Refused("Organization billing is no longer available.", status));
  expect(await f.service.read("team-a")).toEqual({ billing: null, payment: null, error: "Organization billing is no longer available." });
  expect(f.push).toHaveBeenCalledTimes(1);
  expect(await f.service.read("team-a")).toEqual({ billing: null, payment: null, error: "Organization billing is no longer available." });
  expect(f.push).toHaveBeenCalledTimes(1);
});
