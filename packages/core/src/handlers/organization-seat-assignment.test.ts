import { expect, it, vi } from "vitest";
import type { OrganizationSeatReply, OrganizationSeatPreview, SeatAssignmentWork } from "@openorc/protocol";
import { createOrganizationSeatHandlers } from "./organization-seat-assignment.js";

it("preserves an authority refusal and the exact operation identity through the desktop boundary", async () => {
  const denied = { state: "denied", message: "Only an admin can do that." } as const;
  const seats = {
    preview: vi.fn(async (): Promise<OrganizationSeatReply<OrganizationSeatPreview>> => denied),
    assign: vi.fn(async (): Promise<OrganizationSeatReply<SeatAssignmentWork>> => denied),
    operation: vi.fn(async (): Promise<OrganizationSeatReply<SeatAssignmentWork | null>> => denied),
  };
  const handlers = createOrganizationSeatHandlers(seats);
  const request = { seatId: "seat-a", body: { id: "6b556141-a9de-41be-a557-aa938a09b8b8", previewToken: "preview-a" } };
  expect(await handlers["organization.seat.preview"]({ spaceId: "team-a", target: { seatId: "seat-a", memberId: null } })).toEqual(denied);
  expect(await handlers["organization.seat.assign"]({ spaceId: "team-a", request })).toEqual(denied);
  expect(await handlers["organization.billing.operation"]({ spaceId: "team-b", id: request.body.id })).toEqual(denied);
  expect(seats.assign).toHaveBeenCalledExactlyOnceWith("team-a", request);
  expect(seats.operation).toHaveBeenCalledExactlyOnceWith("team-b", request.body.id);
});

it("keeps administration unavailable when there is no cloud service", () => {
  expect(() => createOrganizationSeatHandlers(null)["organization.billing.operation"]({ spaceId: "team-a", id: "unknown" })).toThrow("aren't available");
});
