import type { ClientPush } from "@openorc/client";
import type { SpacesStatus } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { organizationGateConnection } from "./organization-content-gate";
import { OrganizationAccessStore } from "./organization-access-store";

const stores: OrganizationAccessStore[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.dispose());
});

it("shares one reader across consumers and rereads on account, membership, focus and reconnect signals", async () => {
  const read = vi.fn<() => Promise<SpacesStatus>>(async () => ({ state: "signed-out" }));
  const store = new OrganizationAccessStore({ now: Date.now, read });
  stores.push(store);
  let push: (value: ClientPush) => void = () => undefined;
  let focus: () => void = () => undefined;
  const stopPush = vi.fn(),
    stopFocus = vi.fn();
  const source = {
    onPush: vi.fn((listener: (value: ClientPush) => void) => {
      push = listener;
      return stopPush;
    }),
    onFocus: vi.fn((listener: () => void) => {
      focus = listener;
      return stopFocus;
    }),
  };
  const connect = organizationGateConnection(store, source);
  const a = connect(),
    b = connect();
  await Promise.resolve();
  expect(source.onPush).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledTimes(1);
  push({ type: "invalidate", keys: ["account"] });
  push({ type: "invalidate", keys: ["spaces", "people:team-a"] });
  await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(2);
  focus();
  await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(3);
  push({ type: "session", resumed: true });
  await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(4);
  push({ type: "invalidate", keys: ["models", "runs"] });
  await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(4);
  a();
  a();
  expect(stopPush).not.toHaveBeenCalled();
  b();
  expect(stopPush).toHaveBeenCalledTimes(1);
  expect(stopFocus).toHaveBeenCalledTimes(1);
});

it("does not start a queued refresh once its last consumer has left", async () => {
  const read = vi.fn<() => Promise<SpacesStatus>>(async () => ({ state: "signed-out" }));
  const store = new OrganizationAccessStore({ now: Date.now, read });
  stores.push(store);
  const disconnect = organizationGateConnection(store, { onPush: () => () => {}, onFocus: () => () => {} })();
  disconnect();
  await Promise.resolve();
  expect(read).not.toHaveBeenCalled();
});

it("closes cached authority when no consumer listens for membership changes", async () => {
  const read = vi.fn<() => Promise<SpacesStatus>>(async () => ({
    state: "ready",
    userId: "person-a",
    apiOrigin: "https://example.com",
    personalSpaceId: "personal",
    spaces: [{ id: "team-a", kind: "organization", name: "Example team", logo: null, role: "member", memberId: "member-a", memberCount: 1 }],
    create: { allowed: false, reason: null },
    invitations: [],
    reach: "live",
    heardAt: Date.now(),
    organizationAccess: { state: "active", reason: null, until: null, message: null },
    error: null,
  }));
  const store = new OrganizationAccessStore({ now: Date.now, read });
  stores.push(store);
  const connect = organizationGateConnection(store, { onPush: () => () => {}, onFocus: () => () => {} });
  const leave = connect();
  await store.refresh();
  await Promise.resolve();
  const ticket = store.capture("team-a");
  const clear = vi.fn();
  store.subscribeProtected(clear);
  expect(ticket.current()).toBe(true);
  leave();
  expect(ticket.current()).toBe(false);
  expect(clear).toHaveBeenCalledWith(expect.objectContaining({ reason: "authority", removed: [] }));
  const leaveAgain = connect();
  expect(store.status("team-a").allowed).toBe(false);
  leaveAgain();
});
