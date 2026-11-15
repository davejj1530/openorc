import type { OrganizationSeatPreview, SeatAssignmentRequest, SeatAssignmentTarget, SeatAssignmentWork } from "@openorc/protocol";
import { useCallback } from "react";
import type { OrganizationAccessStore } from "./organization-access-store";
import { organizationContentGate } from "./organization-content-gate";
import { SeatAssignment } from "./seat-assignment";
import { useSeatChange, type SeatChangeLease } from "./seat-change-scope";

export interface SeatAssignmentTransport {
  preview(spaceId: string, target: SeatAssignmentTarget): Promise<OrganizationSeatPreview>;
  assign(spaceId: string, request: SeatAssignmentRequest): Promise<SeatAssignmentWork>;
  operation(spaceId: string, id: string): Promise<SeatAssignmentWork | null>;
  subscribe(spaceId: string, refresh: () => void): () => void;
}

/** Seat recovery uses the same admin authority as billing, including frozen administrators. */
export function useSeatAssignment(spaceId: string, transport: SeatAssignmentTransport, gate: OrganizationAccessStore = organizationContentGate, denied?: () => void): SeatAssignment | null {
  const create = useCallback(
    ({ current, guard }: SeatChangeLease) =>
      new SeatAssignment({
        current,
        now: Date.now,
        id: () => crypto.randomUUID(),
        preview: (target) => guard(transport.preview(spaceId, target)),
        send: (request) => guard(transport.assign(spaceId, request)),
        read: (id) => guard(transport.operation(spaceId, id)),
      }),
    [spaceId, transport],
  );
  return useSeatChange(spaceId, create, transport.subscribe, gate, denied);
}
