import type { OrganizationSeatPreview, SeatAssignmentRequest, SeatAssignmentWork } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { SeatAssignment, type SeatAssignmentTarget } from "./seat-assignment";

const target = { seatId: "seat-a", memberId: "member-a" };
const preview: OrganizationSeatPreview = {
  token: "preview-a",
  asOf: 1000,
  expiresAt: 61_000,
  seat: {
    id: "seat-a",
    assignment: { kind: "available" },
    included: { grantedSeconds: 360000, usedSeconds: 7200, leftSeconds: 352800 },
    period: { startsAt: 1000, endsAt: 2_000_000 },
    retiresAt: null,
  },
  to: { memberId: "member-a", person: { id: "person-a", name: "Example person", email: "person@example.com", image: null } },
  previousHolderAfter: null,
  graceUntil: null,
  runningTurnsToStop: 0,
};
const instances: SeatAssignment[] = [];
afterEach(() => {
  instances.splice(0).forEach((view) => view.close());
  vi.useRealTimers();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function completed(request: SeatAssignmentRequest): SeatAssignmentWork {
  return { request, operation: { id: request.body.id, kind: "assignment", state: "complete", message: null }, error: null };
}
function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  let current = true;
  const deps = {
    current: () => current,
    now: () => Date.now(),
    id: vi.fn(() => crypto.randomUUID()),
    preview: vi.fn(async (_target: SeatAssignmentTarget) => structuredClone(preview)),
    send: vi.fn(async (request: SeatAssignmentRequest) => completed(request)),
    read: vi.fn<(id: string) => Promise<SeatAssignmentWork | null>>(async () => null),
  };
  const view = new SeatAssignment(deps);
  instances.push(view);
  view.select(target);
  return {
    view,
    deps,
    revoke: () => {
      current = false;
      view.revoke();
    },
  };
}

it("reviews the selected seat and preserves the server's remainder and dates", async () => {
  const f = fixture();
  expect(f.view.getSnapshot().state).toBe("draft");
  await f.view.review();
  expect(f.deps.preview).toHaveBeenCalledExactlyOnceWith(target);
  expect(f.view.getSnapshot()).toMatchObject({ state: "preview", target, preview, reviewing: false });
  expect(f.deps.send).not.toHaveBeenCalled();
});

it("clears a preview on an edit and discards the previous target's late reply", async () => {
  const f = fixture(),
    late = deferred<OrganizationSeatPreview>();
  f.deps.preview.mockReturnValueOnce(late.promise);
  const reading = f.view.review();
  expect(f.view.getSnapshot().reviewing).toBe(true);
  const next = { ...target, memberId: "member-b" };
  f.view.select(next);
  late.resolve(preview);
  await reading;
  expect(f.view.getSnapshot()).toMatchObject({ state: "draft", target: next, preview: null, reviewing: false });
  await f.view.confirm();
  expect(f.deps.send).not.toHaveBeenCalled();
});

it("invalidates the preview exactly at its server deadline while offline", async () => {
  const f = fixture();
  await f.view.review();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.view.getSnapshot()).toMatchObject({ state: "draft", preview: null, error: "That seat has changed. Review the change again." });
  await f.view.confirm();
  expect(f.deps.send).not.toHaveBeenCalled();
});

it("checks an expired preview synchronously when timers were suspended", async () => {
  const f = fixture();
  await f.view.review();
  vi.setSystemTime(61_000);
  await f.view.confirm();
  expect(f.deps.send).not.toHaveBeenCalled();
  expect(f.view.getSnapshot()).toMatchObject({ state: "draft", preview: null });
});

it("claims one id before notifications can reenter submission", async () => {
  const f = fixture(),
    late = deferred<SeatAssignmentWork>();
  f.deps.send.mockReturnValueOnce(late.promise);
  await f.view.review();
  f.view.subscribe(() => {
    if (f.view.getSnapshot().state === "submitting") void f.view.confirm();
  });
  const first = f.view.confirm(),
    second = f.view.confirm();
  await Promise.resolve();
  expect(f.view.getSnapshot().state).toBe("submitting");
  expect(f.deps.id).toHaveBeenCalledTimes(1);
  expect(f.deps.send).toHaveBeenCalledTimes(1);
  const request = f.deps.send.mock.calls[0]![0];
  expect(request).toMatchObject({ seatId: "seat-a", body: { previewToken: "preview-a" } });
  late.resolve(completed(request));
  await Promise.all([first, second]);
  expect(f.view.getSnapshot().state).toBe("complete");
});

it("keeps a lost response pending and repeats the exact request only on a press", async () => {
  const f = fixture();
  f.deps.send.mockRejectedValueOnce(new Error("Connection lost"));
  await f.view.review();
  await f.view.confirm();
  const request = f.deps.send.mock.calls[0]![0];
  expect(f.view.getSnapshot()).toMatchObject({ state: "pending", error: "Connection lost" });
  f.view.select({ ...target, memberId: "member-b" });
  await f.view.review();
  await f.view.refresh();
  expect(f.deps.send).toHaveBeenCalledTimes(1);
  expect(f.deps.read).toHaveBeenCalledExactlyOnceWith(request.body.id);
  await f.view.retry();
  expect(f.deps.send.mock.calls).toEqual([[request], [request]]);
  expect(f.deps.id).toHaveBeenCalledTimes(1);
});

it("retains completion after a failed following read and retries only the read", async () => {
  const f = fixture();
  f.deps.send.mockImplementationOnce(async (request) => ({ ...completed(request), error: "People could not be read." }));
  await f.view.review();
  await f.view.confirm();
  const work = f.view.getSnapshot().work!;
  expect(f.view.getSnapshot()).toMatchObject({ state: "complete", error: "People could not be read." });
  f.deps.read.mockRejectedValueOnce(new Error("Offline"));
  await f.view.retry();
  expect(f.view.getSnapshot()).toMatchObject({ state: "complete", error: "Offline" });
  f.deps.read.mockResolvedValueOnce({ ...work, error: null });
  await f.view.retry();
  expect(f.view.getSnapshot()).toMatchObject({ state: "complete", error: null });
  expect(f.deps.send).toHaveBeenCalledTimes(1);
});

it("requires a fresh preview after a terminal stale-preview refusal", async () => {
  const f = fixture();
  f.deps.send.mockImplementationOnce(async (request) => ({
    request,
    operation: { id: request.body.id, kind: "assignment", state: "failed", message: "That seat has changed. Review the change again." },
    error: null,
  }));
  await f.view.review();
  await f.view.confirm();
  expect(f.view.getSnapshot()).toMatchObject({ state: "failed", error: "That seat has changed. Review the change again." });
  await f.view.retry();
  expect(f.deps.send).toHaveBeenCalledTimes(1);
  f.deps.preview.mockResolvedValueOnce({ ...preview, token: "preview-b" });
  await f.view.review();
  await f.view.confirm();
  expect(f.deps.send.mock.calls[1]![0].body.previewToken).toBe("preview-b");
  expect(f.deps.send.mock.calls[1]![0].body.id).not.toBe(f.deps.send.mock.calls[0]![0].body.id);
});

it.each(["seat", "person"])("refuses a preview for a different %s", async (kind) => {
  const f = fixture();
  f.deps.preview.mockResolvedValueOnce(kind === "seat" ? { ...preview, seat: { ...preview.seat, id: "seat-b" } } : { ...preview, to: null });
  await f.view.review();
  await f.view.confirm();
  expect(f.view.getSnapshot()).toMatchObject({ state: "failed", preview: null });
  expect(f.deps.send).not.toHaveBeenCalled();
});

it("purges private preview details after losing admin and fences late responses", async () => {
  const f = fixture(),
    late = deferred<OrganizationSeatPreview>();
  f.deps.preview.mockReturnValueOnce(late.promise);
  const reading = f.view.review();
  f.revoke();
  late.resolve(preview);
  await reading;
  expect(f.view.getSnapshot()).toMatchObject({ target: null, preview: null, work: null, error: null });
  await f.view.confirm();
  expect(f.deps.send).not.toHaveBeenCalled();
});

it("does not start a queued mutation after a synchronous authority change", async () => {
  const f = fixture();
  await f.view.review();
  f.view.subscribe(() => {
    if (f.view.getSnapshot().state === "submitting") f.revoke();
  });
  await f.view.confirm();
  expect(f.deps.send).not.toHaveBeenCalled();
  expect(f.view.getSnapshot().work).toBeNull();
});

it("closing clears the view without cancelling a committed operation", async () => {
  const f = fixture(),
    late = deferred<SeatAssignmentWork>();
  f.deps.send.mockReturnValueOnce(late.promise);
  await f.view.review();
  const sending = f.view.confirm();
  await Promise.resolve();
  const request = f.deps.send.mock.calls[0]![0];
  f.view.close();
  late.resolve(completed(request));
  await sending;
  expect(f.view.getSnapshot()).toMatchObject({ target: null, preview: null, work: null });
  expect(f.deps.send).toHaveBeenCalledTimes(1);
});

it("restores durable pending work without retaining another preview's private details", async () => {
  const f = fixture();
  await f.view.review();
  const request = { seatId: "seat-b", body: { id: crypto.randomUUID(), previewToken: "saved-preview" } };
  f.view.resume({ request, operation: null, error: "Connection lost" });
  expect(f.view.getSnapshot()).toMatchObject({ state: "pending", target: null, preview: null, work: { request } });
  expect(f.deps.send).not.toHaveBeenCalled();
  f.deps.read.mockResolvedValueOnce(completed(request));
  await f.view.refresh();
  expect(f.view.getSnapshot().state).toBe("complete");
  f.view.resume({ request, operation: null, error: null });
  expect(f.view.getSnapshot().state).toBe("complete");
});

it("does not accept another operation's reply as evidence that the change completed", async () => {
  const f = fixture();
  f.deps.send.mockImplementationOnce(async (request) => completed({ ...request, body: { ...request.body, id: crypto.randomUUID() } }));
  await f.view.review();
  await f.view.confirm();
  expect(f.view.getSnapshot()).toMatchObject({ state: "pending", error: "The seat change could not be confirmed. Try again." });
  const request = f.deps.send.mock.calls[0]![0];
  await f.view.retry();
  expect(f.deps.send.mock.calls).toEqual([[request], [request]]);
});

it("remembers preview facts only for the exact reopened operation and clears them on revocation", async () => {
  const f = fixture();
  await f.view.review();
  const preview = f.view.getSnapshot().preview!;
  const request = { seatId: preview.seat.id, body: { id: crypto.randomUUID(), previewToken: preview.token } };
  f.view.resume({ request, operation: null, error: null }, preview);
  expect(f.view.getSnapshot().preview).toEqual(preview);
  f.view.resume({ request, operation: null, error: null }, { ...preview, token: "another-preview" });
  expect(f.view.getSnapshot().preview).toBeNull();
  f.view.resume({ request, operation: null, error: null }, preview);
  f.view.revoke();
  expect(f.view.getSnapshot().preview).toBeNull();
});
