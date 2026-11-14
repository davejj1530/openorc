import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OrganizationBillingStatus, OrganizationPerson, OrganizationSeat, SeatAssignmentRequest, SpacesStatus } from "@openorc/protocol";
import { queryClient } from "../lib/client";
import { organizationContentGate } from "../lib/organization-content-gate";
import { OrganizationSeatAdministration } from "./OrganizationSeatAdministration";
import { OrganizationPersonPlan } from "./OrganizationPersonPlan";
import { PersonSeatMenu } from "./PersonSeatActions";
import { SeatInventoryActions } from "./SeatInventoryActions";

const mock = vi.hoisted(() => ({ call: vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>() }));
vi.mock("../lib/rpc", () => ({ core: { call: mock.call, onPush: () => () => {}, onReady: () => () => {} } }));
vi.mock("../lib/seat-administration", async (original) => ({ ...(await original<object>()), SEAT_ASSIGNMENT_ENABLED: true }));

const person: OrganizationPerson = {
  memberId: "member-a",
  userId: "person-a",
  name: "Sample Person",
  email: "person@example.com",
  image: null,
  role: "admin",
  plan: "pro",
  joinedAt: 1,
  seat: { id: null, paysForPro: true },
};
const other: OrganizationPerson = { ...person, memberId: "member-b", userId: "person-b", name: "Other Person", email: "other@example.com", role: "member", seat: { id: null, paysForPro: false } };
const seat = (id: string, leftSeconds: number): OrganizationSeat => ({
  id,
  assignment: { kind: "available" },
  period: { startsAt: 1, endsAt: Date.now() + 86_400_000 },
  included: { grantedSeconds: 360000, usedSeconds: 360000 - leftSeconds, leftSeconds },
  retiresAt: null,
});
let status: Extract<SpacesStatus, { state: "ready" }>;
let billing: OrganizationBillingStatus;
let denied = false;
let rows: OrganizationPerson[];

beforeEach(async () => {
  queryClient.clear();
  vi.clearAllMocks();
  denied = false;
  rows = structuredClone([person, other]);
  status = {
    state: "ready",
    userId: "person-a",
    apiOrigin: "https://example.com",
    personalSpaceId: "personal",
    spaces: [{ id: "team-a", kind: "organization", name: "Example team", logo: null, role: "admin", memberId: "member-a", memberCount: 2 }],
    create: { allowed: false, reason: null },
    invitations: [],
    reach: "live",
    heardAt: Date.now(),
    error: null,
    organizationAccess: { state: "active", reason: null, until: null, message: null },
  };
  billing = {
    billing: {
      organization: { id: "team-a", name: "Example team", logo: null },
      revision: "revision-a",
      asOf: Date.now(),
      subscription: { id: "paid-a", plan: "monthly", standing: "live", quantity: 2, overallocated: false, paidUntil: Date.now() + 86_400_000, graceUntil: null, pendingQuantity: null },
      available: 2,
      seats: [seat("less", 100), seat("fullest", 200)],
    },
    payment: null,
    error: null,
  };
  mock.call.mockImplementation(async (method, params) => {
    if (method === "spaces.refresh") return { ...status, heardAt: Date.now() };
    if (method === "organization.billing.get") return denied ? { billing: null, payment: null, error: "Only an admin can do that." } : billing;
    if (method === "organization.people") return { organization: billing.billing!.organization, viewer: { memberId: "member-a", role: "admin" }, total: 2, adminCount: 1, members: rows };
    if (method === "organization.seat.preview") {
      const target = params["target"] as { seatId: string; memberId: string | null };
      const to = rows.find((row) => row.memberId === target.memberId);
      return {
        state: "ready",
        value: {
          token: "preview-a",
          expiresAt: Date.now() + 60_000,
          asOf: Date.now(),
          seat: billing.billing!.seats.find((row) => row.id === target.seatId),
          to: to ? { memberId: to.memberId, person: { id: to.userId, name: to.name, email: to.email, image: null } } : null,
          previousHolderAfter: null,
          graceUntil: null,
          runningTurnsToStop: 0,
        },
      };
    }
    if (method === "organization.seat.assign") {
      if (denied) return { state: "denied", message: "Only an admin can do that." };
      const request = params["request"] as SeatAssignmentRequest;
      return { state: "ready", value: { request, operation: { id: request.body.id, kind: "assignment", state: "complete", message: null }, error: null } };
    }
    return {};
  });
  await organizationContentGate.refresh();
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  organizationContentGate.reset();
});

function show() {
  return render(
    <QueryClientProvider client={queryClient}>
      <OrganizationSeatAdministration spaceId="team-a">
        {rows.map((row) => (
          <div key={row.memberId}>
            <OrganizationPersonPlan spaceId="team-a" person={row} />
            <PersonSeatMenu self={row.memberId === "member-a"} person={row} spaceId="team-a" editable={false} onRemove={() => {}} />
          </div>
        ))}
        <SeatInventoryActions seat={billing.billing!.seats[0]!} />
      </OrganizationSeatAdministration>
    </QueryClientProvider>,
  );
}

it("gives the sole admin a fullest-seat action without exposing role or removal controls", async () => {
  show();
  fireEvent.click(await screen.findByRole("button", { name: "More for Sample Person" }));
  expect(screen.queryByText("Remove member…")).toBeNull();
  fireEvent.click(await screen.findByRole("menuitem", { name: "Give seat…" }));
  await screen.findByRole("button", { name: "Give seat" });
  expect(screen.getByRole("dialog", { name: "Give Sample a seat" })).toBeTruthy();
  expect(screen.getByText("Sample pays for Pro themselves. Their own included hours stay in use.")).toBeTruthy();
  expect(mock.call).toHaveBeenCalledWith("organization.seat.preview", { spaceId: "team-a", target: { seatId: "fullest", memberId: "member-a" } });
  fireEvent.click(screen.getByRole("button", { name: "Give seat" }));
  await screen.findByRole("dialog", { name: "Seat moved" });
  expect(mock.call.mock.calls.filter(([method]) => method === "organization.seat.assign")).toHaveLength(1);
});

it("an inventory row keeps its specific seat and asks for a person", async () => {
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Seat actions" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Give…" }));
  fireEvent.click(await screen.findByRole("radio", { name: /Other Person/ }));
  fireEvent.click(screen.getByRole("button", { name: "Review seat" }));
  await waitFor(() => expect(mock.call).toHaveBeenCalledWith("organization.seat.preview", { spaceId: "team-a", target: { seatId: "less", memberId: "member-b" } }));
});

it("a structured refusal closes the preview and clears other people's private facts before a roster update", async () => {
  rows[1]!.seat = { id: "less", paysForPro: false };
  show();
  await screen.findByText("Seat");
  fireEvent.click(await screen.findByRole("button", { name: "More for Sample Person" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Give seat…" }));
  await screen.findByRole("button", { name: "Give seat" });
  denied = true;
  fireEvent.click(screen.getByRole("button", { name: "Give seat" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.queryByText("Seat")).toBeNull();
  expect(screen.queryByRole("button", { name: "More for Other Person" })).toBeNull();
  await act(async () => {
    status = { ...status, userId: "person-b", spaces: [] };
    await organizationContentGate.refresh();
  });
  expect(screen.queryByText("Pays for Pro")).toBeNull();
});
