import type { OrganizationAccess, SpacesStatus } from "@openorc/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationAccessStore, type OrganizationProtectionChange } from "./organization-access-store";

const active: OrganizationAccess = { state: "active", reason: null, until: null, message: null };
const grace: OrganizationAccess = { state: "grace", reason: "seat_removed", until: 2000, message: "Your seat was taken back; you have one day to get Pro to keep using organizations." };
function spaces(access: OrganizationAccess | undefined = active, heardAt = Date.now()): Extract<SpacesStatus, { state: "ready" }> {
  return {
    state: "ready",
    userId: "person-a",
    apiOrigin: "https://example.com",
    personalSpaceId: "personal-a",
    spaces: [
      { id: "personal-a", kind: "personal" },
      ...["team-a", "team-b"].map((id) => ({ id, kind: "organization" as const, name: id, logo: null, memberId: id + "-member", role: "admin" as const, memberCount: 1 })),
    ],
    create: { allowed: true, reason: null },
    invitations: [],
    reach: "live",
    heardAt,
    error: null,
    organizationAccess: access,
  };
}
const stores: OrganizationAccessStore[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});
afterEach(() => {
  stores.splice(0).forEach((store) => store.dispose());
  vi.useRealTimers();
});
function fixture(access: OrganizationAccess | undefined = active) {
  let answer: SpacesStatus = spaces(access);
  const read = vi.fn(async () => answer);
  const store = new OrganizationAccessStore({ now: Date.now, read });
  stores.push(store);
  return {
    store,
    read,
    answer: (next: SpacesStatus) => {
      answer = next;
    },
  };
}
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("shared organization content authority", () => {
  it("starts closed for team content and never interprets a missing old-server gate as paid access", async () => {
    const f = fixture();
    expect(f.store.status("team-a").allowed).toBe(false);
    f.answer({ ...spaces(), organizationAccess: undefined });
    await f.store.refresh();
    expect(f.store.status("team-a")).toMatchObject({ allowed: false, blocked: "unknown" });
    expect(f.store.status("personal-a").allowed).toBe(true);
    expect(f.store.status(null).allowed).toBe(true);
  });

  it("uses one entitlement for both memberships and keeps ordinary membership separate", async () => {
    const { store } = fixture();
    await store.refresh();
    expect(store.status("team-a").allowed).toBe(true);
    expect(store.status("team-b").allowed).toBe(true);
    expect(store.status("foreign")).toMatchObject({ allowed: false, blocked: "membership" });
  });

  it("closes both organizations exactly at the deadline, clearing protected caches before visible subscribers", async () => {
    const { store } = fixture(grace);
    await store.refresh();
    const ticket = store.capture("team-a");
    const order: string[] = [];
    store.subscribeProtected((change) => {
      order.push("purge");
      expect(change).toMatchObject({ reason: "frozen", spaceIds: ["team-a", "team-b"], removed: [] });
    });
    store.subscribe(() => {
      order.push("render");
      expect(store.status("team-a").allowed).toBe(false);
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(ticket.current()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(order.slice(0, 2)).toEqual(["purge", "render"]);
    expect(ticket.current()).toBe(false);
    expect(store.status("team-b")).toMatchObject({ allowed: false, access: { state: "frozen", reason: "seat_removed", message: "Your seat was taken back, and your day of grace has ended." } });
    expect(store.status("personal-a").allowed).toBe(true);
  });

  it("keeps the frozen private reason when offline at the deadline", async () => {
    const f = fixture(grace);
    await f.store.refresh();
    f.read.mockRejectedValue(new Error("Offline"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.store.status("team-a")).toMatchObject({ allowed: false, blocked: "frozen", access: { reason: "seat_removed" } });
    expect(f.store.getSnapshot().error).toBe("Offline");
  });

  it("rejects an active reply started before expiry and a cached active reply read afterward", async () => {
    const f = fixture(grace);
    await f.store.refresh();
    const old = deferred<SpacesStatus>();
    f.read.mockReturnValueOnce(old.promise);
    const inFlight = f.store.refresh();
    await vi.advanceTimersByTimeAsync(1000);
    old.resolve(spaces(active, 1999));
    await inFlight;
    expect(f.store.status("team-a").allowed).toBe(false);
    f.answer(spaces(active, 1999));
    await f.store.refresh();
    expect(f.store.status("team-a").allowed).toBe(false);
  });

  it("a fresh paid recovery reopens access without reviving a pre-freeze content request", async () => {
    const f = fixture(grace);
    await f.store.refresh();
    const old = f.store.capture("team-a");
    await vi.advanceTimersByTimeAsync(1001);
    f.answer(spaces(active));
    await f.store.refresh();
    expect(f.store.status("team-a").allowed).toBe(true);
    expect(old.current()).toBe(false);
    expect(f.store.capture("team-a").current()).toBe(true);
  });

  it("reports membership loss separately so private drafts can be retained on freeze and removed on departure", async () => {
    const f = fixture();
    await f.store.refresh();
    const events: OrganizationProtectionChange[] = [];
    f.store.subscribeProtected((change) => events.push(change));
    const next = spaces();
    next.spaces = next.spaces.filter((space) => space.id !== "team-a");
    f.answer(next);
    await f.store.refresh();
    expect(events.at(-1)).toMatchObject({ reason: "membership", removed: ["team-a"] });
    expect(f.store.status("team-a").blocked).toBe("membership");
    expect(f.store.status("team-b").allowed).toBe(true);
  });

  it("fences content when admin authority changes without treating it as membership loss", async () => {
    const f = fixture();
    await f.store.refresh();
    const old = f.store.capture("team-a");
    const listener = vi.fn();
    f.store.subscribeProtected(listener);
    const next = spaces();
    next.spaces = next.spaces.map((space) => (space.kind === "organization" && space.id === "team-a" ? { ...space, role: "member" } : space));
    f.answer(next);
    await f.store.refresh();
    expect(old.current()).toBe(false);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ reason: "authority", removed: [] }));
    expect(f.store.status("team-a").allowed).toBe(true);
  });

  it("discards out-of-order refreshes and closes on sign-out or a changed account", async () => {
    const f = fixture();
    await f.store.refresh();
    const old = deferred<SpacesStatus>();
    f.read.mockReturnValueOnce(old.promise);
    const reading = f.store.refresh();
    f.answer({ state: "signed-out" });
    await f.store.refresh();
    old.resolve(spaces());
    await reading;
    expect(f.store.status("team-a").allowed).toBe(false);
    f.answer({ ...spaces(), userId: "person-b" });
    await f.store.refresh();
    expect(f.store.status("team-a").identity).toBe(JSON.stringify(["https://example.com", "person-b"]));
  });

  it("closes an organization the person leaves at once, ending its leases and clearing its caches, until a read opens it again", async () => {
    const f = fixture();
    await f.store.refresh();
    const lease = f.store.capture("team-a");
    const cleared: OrganizationProtectionChange[] = [];
    f.store.subscribeProtected((change) => cleared.push(change));
    // A read already on its way, answered from before the leave, doesn't bring the organization back.
    const old = deferred<SpacesStatus>();
    f.read.mockReturnValueOnce(old.promise);
    const reading = f.store.refresh();
    f.store.close("team-a");
    expect(lease.current()).toBe(false);
    expect(f.store.status("team-a").blocked).toBe("membership");
    expect(f.store.status("team-b").allowed).toBe(true);
    expect(cleared).toMatchObject([{ reason: "membership", removed: ["team-a"] }]);
    old.resolve(spaces());
    await reading;
    expect(f.store.status("team-a").allowed).toBe(false);
    // Refused, the person is still in it: the next read opens it again.
    await f.store.refresh();
    expect(f.store.status("team-a").allowed).toBe(true);
  });

  it("checks the deadline synchronously when suspended timers have not run yet", async () => {
    const f = fixture(grace);
    await f.store.refresh();
    const old = f.store.capture("team-a");
    vi.setSystemTime(2001);
    expect(old.current()).toBe(false);
    expect(f.store.status("team-a").blocked).toBe("frozen");
  });

  it("a read failure never turns missing authority into access or signs out an active offline member", async () => {
    const f = fixture();
    f.read.mockRejectedValueOnce(new Error("Offline"));
    await f.store.refresh();
    expect(f.store.status("team-a").allowed).toBe(false);
    await f.store.refresh();
    f.read.mockRejectedValueOnce(new Error("Offline"));
    await f.store.refresh();
    expect(f.store.status("team-a").allowed).toBe(true);
  });

  it("reset closes caches before a restarted core can answer and invalidates earlier read tickets", async () => {
    const f = fixture();
    await f.store.refresh();
    const old = f.store.capture("team-a");
    const later = deferred<SpacesStatus>();
    f.read.mockReturnValueOnce(later.promise);
    const reading = f.store.refresh();
    f.store.reset();
    later.resolve(spaces());
    await reading;
    expect(old.current()).toBe(false);
    expect(f.store.status("team-a").allowed).toBe(false);
  });

  it("requires a fresh read after listening resumes and does not infer that a member left", async () => {
    const f = fixture();
    await f.store.refresh();
    const clear = vi.fn();
    f.store.subscribeProtected(clear);
    f.store.suspend();
    expect(clear).toHaveBeenCalledWith(expect.objectContaining({ reason: "authority", removed: [] }));
    vi.setSystemTime(2000);
    f.answer({ ...spaces(active, 1000), reach: "offline", error: "Offline" });
    await f.store.refresh();
    expect(f.store.status("team-a")).toMatchObject({ allowed: false, error: "Offline" });
    f.answer(spaces());
    await f.store.refresh();
    expect(f.store.status("team-a").allowed).toBe(true);
  });

  it("exposes an initial read failure for retry while remaining closed", async () => {
    const f = fixture();
    f.answer({ state: "loading", error: "Offline" });
    await f.store.refresh();
    expect(f.store.status("team-a")).toMatchObject({ allowed: false, error: "Offline" });
  });

  it("rejects a callback bound to another account before it starts a request", async () => {
    const f = fixture();
    await f.store.refresh();
    expect(f.store.capture("team-a", "person-b").current()).toBe(false);
    expect(f.store.capture("team-a", "person-a").current()).toBe(true);
    f.answer({ ...spaces(), userId: "person-b" });
    await f.store.refresh();
    expect(f.store.capture("team-a", "person-a").current()).toBe(false);
    expect(f.store.capture("team-a", "person-b").current()).toBe(true);
  });
});
