import type { SeatAssignmentRequest } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { OrganizationSeatAssignment } from "./organization-seat-assignment.js";
import { Refused } from "./session.js";
import type { Route } from "./wire.js";

const date = "2026-11-01T00:00:00.000Z";
const wire = {
  token: "preview-a",
  asOf: date,
  expiresAt: "2026-11-01T00:01:00.000Z",
  seat: {
    id: "seat-a",
    assignment: { kind: "available" },
    included: { grantedSeconds: 360000, usedSeconds: 123, leftSeconds: 359877 },
    period: { startsAt: date, endsAt: "2026-12-01T00:00:00.000Z" },
    retiresAt: null,
  },
  to: { memberId: "member-a", person: { id: "person-a", name: "Example person", email: "person@example.com", image: null } },
  previousHolderAfter: null,
  graceUntil: null,
  runningTurnsToStop: 0,
};
const target = { seatId: "seat-a", memberId: "member-a" };
const request: SeatAssignmentRequest = { seatId: "seat-a", body: { id: "6b556141-a9de-41be-a557-aa938a09b8b8", previewToken: "preview-a" } };
const complete = { id: request.body.id, kind: "assignment", state: "complete", message: null };
const services: OrganizationSeatAssignment[] = [];
afterEach(() => {
  services.splice(0).forEach((service) => service.close());
  vi.useRealTimers();
});
function journal() {
  let value: string | null = null;
  return {
    load: () => value,
    save: (next: string) => {
      value = next;
    },
  };
}
function fixture(storage = journal()) {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse(date));
  let current = true;
  const respond = vi.fn<(path: string, body: unknown) => Promise<unknown>>(async () => wire);
  const calls: { method: string; path: string; body: unknown }[] = [];
  const deps = {
    scope: { origin: "https://example.com", userId: "person-a", spaceId: "team-a" },
    storage,
    current: () => current,
    now: () => Date.now(),
    request: async <T>(route: Route<T>, body?: unknown): Promise<T> => {
      calls.push({ method: route.method, path: route.path, body });
      if (!route.reply) throw new Error("A reply schema is required.");
      return route.reply.parse(await respond(route.path, body));
    },
    refresh: vi.fn(async () => {}),
    changed: vi.fn(),
  };
  const service = new OrganizationSeatAssignment(deps);
  services.push(service);
  return {
    service,
    deps,
    calls,
    respond,
    revoke: () => {
      current = false;
    },
  };
}

it("reads the selected member preview and preserves its allowance snapshot", async () => {
  const f = fixture();
  const preview = await f.service.preview(target);
  expect(f.calls).toEqual([{ method: "POST", path: "/organization/seats/seat-a/preview", body: { memberId: "member-a" } }]);
  expect(preview).toMatchObject({ token: "preview-a", asOf: Date.parse(date), expiresAt: Date.parse(wire.expiresAt), seat: { included: wire.seat.included } });
  expect(f.deps.storage.load()).toBeNull();
});

it("rejects a changed subject or an expired preview before it can be confirmed", async () => {
  const f = fixture();
  f.respond.mockResolvedValueOnce({ ...wire, to: null });
  await expect(f.service.preview(target)).rejects.toThrow("That seat has changed. Review the change again.");
  vi.setSystemTime(Date.parse(wire.expiresAt));
  await expect(f.service.preview(target)).rejects.toThrow("That seat has changed. Review the change again.");
});

it("fences a preview after losing its captured account or admin scope", async () => {
  const f = fixture();
  f.respond.mockImplementationOnce(async () => {
    f.revoke();
    return wire;
  });
  await expect(f.service.preview(target)).rejects.toThrow("Your organization access changed. Try again.");
  await expect(f.service.send(request)).rejects.toThrow("Your organization access changed. Try again.");
  expect(f.calls).toHaveLength(1);
  expect(f.service.list()).toEqual([]);
});

it("journals before sending and preserves completion when the following inventory read fails", async () => {
  const f = fixture();
  f.respond.mockImplementationOnce(async (_path, body) => {
    expect(f.deps.storage.load()).toContain(JSON.stringify(request));
    expect(body).toEqual(request.body);
    return complete;
  });
  f.deps.refresh.mockRejectedValueOnce(new Error("Inventory unavailable"));
  expect(await f.service.send(request)).toMatchObject({ operation: complete, error: "Inventory unavailable" });
  expect(await f.service.read(request.body.id)).toMatchObject({ operation: complete, error: null });
  expect(f.calls.map((call) => call.method)).toEqual(["PATCH"]);
  expect(f.deps.refresh).toHaveBeenCalledTimes(2);
});

it("polls only reads for a lost reply, including after a core restart", async () => {
  const storage = journal(),
    first = fixture(storage);
  first.respond.mockRejectedValueOnce(new TypeError("Connection lost"));
  await first.service.send(request);
  first.service.close();
  const second = fixture(storage);
  second.respond.mockRejectedValue(new Refused("Unknown operation", 404));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(second.calls).toEqual([{ method: "GET", path: `/organization/billing/operations/${request.body.id}`, body: undefined }]);
  expect(second.service.list()).toMatchObject([{ request, operation: null }]);
  second.respond.mockResolvedValueOnce(complete);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(second.service.list()).toMatchObject([{ operation: complete }]);
  const reads = second.calls.length;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(second.calls).toHaveLength(reads);
  expect(first.calls.map((call) => call.method)).toEqual(["PATCH"]);
});

it("closes pending polling and clears public work after authority ends", async () => {
  const f = fixture();
  f.respond.mockResolvedValueOnce({ ...complete, state: "pending" });
  await f.service.send(request);
  f.revoke();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(f.calls).toHaveLength(1);
  expect(f.service.list()).toEqual([]);
  expect(f.deps.storage.load()).toContain(request.body.id);
});
