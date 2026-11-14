import { StrictMode, type ReactNode } from "react";
import type { OrganizationSeatPreview, SeatAssignmentRequest, SeatAssignmentTarget, SeatAssignmentWork, SpacesStatus } from "@openorc/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OrganizationAccessStore } from "./organization-access-store";
import { useSeatAssignment, type SeatAssignmentTransport } from "./seat-assignment-scope";
import { SeatAdministrationLost } from "./seat-administration-lost";

const target = { seatId: "seat-a", memberId: "member-b" };
const preview: OrganizationSeatPreview = {
  token: "preview-a",
  asOf: Date.now(),
  expiresAt: Date.now() + 60_000,
  seat: { id: "seat-a", assignment: { kind: "available" }, period: null, included: null, retiresAt: null },
  to: { memberId: "member-b", person: { id: "person-b", name: "Alex Example", email: "alex@example.com", image: null } },
  previousHolderAfter: null,
  graceUntil: null,
  runningTurnsToStop: 0,
};
const gates: OrganizationAccessStore[] = [];
afterEach(() => {
  cleanup();
  gates.splice(0).forEach((gate) => gate.dispose());
});
async function fixture() {
  let status: Extract<SpacesStatus, { state: "ready" }> = {
    state: "ready",
    apiOrigin: "https://example.com",
    userId: "person-a",
    personalSpaceId: "personal",
    create: { allowed: false, reason: null },
    invitations: [],
    reach: "live",
    heardAt: Date.now(),
    error: null,
    spaces: [{ id: "team-a", kind: "organization", name: "Example team", logo: null, role: "admin", memberId: "member-a", memberCount: 2 }],
    organizationAccess: { state: "frozen", reason: "no_pro", until: null, message: "You need Pro to use an organization. Open Account or ask an admin for a seat." },
  };
  const gate = new OrganizationAccessStore({ now: Date.now, read: async () => status });
  gates.push(gate);
  await gate.refresh();
  const transport = {
    preview: vi.fn(async (_space: string, _target: SeatAssignmentTarget) => preview),
    assign: vi.fn(async (_space: string, request: SeatAssignmentRequest): Promise<SeatAssignmentWork> => ({ request, operation: null, error: null })),
    operation: vi.fn(async (_space: string, _id: string): Promise<SeatAssignmentWork | null> => null),
    subscribe: vi.fn(() => () => {}),
  } satisfies SeatAssignmentTransport;
  const setRole = async (role: "admin" | "member") => {
    status = { ...status, spaces: status.spaces.map((space) => (space.kind === "organization" ? { ...space, role } : space)) };
    await act(() => gate.refresh());
  };
  return { gate, transport, setRole };
}

it("allows frozen admin recovery using the shared gate without starting a mutation", async () => {
  const f = await fixture();
  const hook = renderHook(() => useSeatAssignment("team-a", f.transport, f.gate), { wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode> });
  expect(hook.result.current).not.toBeNull();
  await act(async () => {
    hook.result.current!.select(target);
    await hook.result.current!.review();
  });
  expect(hook.result.current!.getSnapshot().preview).toEqual(preview);
  expect(f.transport.preview).toHaveBeenCalledExactlyOnceWith("team-a", target);
  expect(f.transport.assign).not.toHaveBeenCalled();
});

it("clears a private preview synchronously when core refuses admin access before the roster changes", async () => {
  const f = await fixture();
  const denied = vi.fn();
  const hook = renderHook(() => useSeatAssignment("team-a", f.transport, f.gate, denied));
  await act(async () => {
    hook.result.current!.select(target);
    await hook.result.current!.review();
  });
  expect(hook.result.current!.getSnapshot().preview).toEqual(preview);
  f.transport.assign.mockRejectedValueOnce(new SeatAdministrationLost("Only an admin can do that."));
  await act(() => hook.result.current!.confirm());
  expect(hook.result.current!.getSnapshot()).toMatchObject({ preview: null, target: null, work: null });
  expect(denied).toHaveBeenCalledOnce();
  await act(() => hook.result.current!.retry());
  expect(f.transport.assign).toHaveBeenCalledOnce();
});

it("purges an admin preview on demotion and cannot revive it after promotion", async () => {
  const f = await fixture();
  let resolve!: (value: OrganizationSeatPreview) => void;
  f.transport.preview.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const hook = renderHook(() => useSeatAssignment("team-a", f.transport, f.gate));
  const old = hook.result.current!;
  let reading!: Promise<void>;
  act(() => {
    old.select(target);
    reading = old.review();
  });
  await f.setRole("member");
  expect(hook.result.current).toBeNull();
  expect(old.getSnapshot()).toMatchObject({ preview: null, target: null, work: null });
  await f.setRole("admin");
  await act(async () => {
    resolve(preview);
    await reading;
  });
  expect(hook.result.current).not.toBe(old);
  expect(old.getSnapshot().preview).toBeNull();
});

it("prevents callbacks from sending after their dialog unmounts", async () => {
  const f = await fixture();
  const hook = renderHook(() => useSeatAssignment("team-a", f.transport, f.gate));
  const old = hook.result.current!;
  await act(async () => {
    old.select(target);
    await old.review();
  });
  hook.unmount();
  await old.confirm();
  expect(f.transport.assign).not.toHaveBeenCalled();
  expect(old.getSnapshot().preview).toBeNull();
});
