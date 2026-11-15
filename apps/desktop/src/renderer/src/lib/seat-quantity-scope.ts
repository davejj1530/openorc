import type { SeatQuantityPreview, SeatQuantityRequest, SeatQuantityWork } from "@openorc/protocol";
import { useCallback } from "react";
import type { OrganizationAccessStore } from "./organization-access-store";
import { organizationContentGate } from "./organization-content-gate";
import { useSeatChange, type SeatChangeLease } from "./seat-change-scope";
import { SeatQuantity } from "./seat-quantity";

export interface SeatQuantityTransport {
  preview(spaceId: string, seats: number): Promise<SeatQuantityPreview>;
  confirm(spaceId: string, request: SeatQuantityRequest): Promise<SeatQuantityWork>;
  operation(spaceId: string, id: string): Promise<SeatQuantityWork | null>;
  subscribe(spaceId: string, refresh: () => void): () => void;
}

/** Changing the number of seats, under the same admin authority as the rest of the organization's billing. */
export function useSeatQuantity(spaceId: string, transport: SeatQuantityTransport, gate: OrganizationAccessStore = organizationContentGate): SeatQuantity | null {
  const create = useCallback(
    ({ current, guard }: SeatChangeLease) =>
      new SeatQuantity({
        current,
        now: Date.now,
        id: () => crypto.randomUUID(),
        preview: (seats) => guard(transport.preview(spaceId, seats)),
        send: (request) => guard(transport.confirm(spaceId, request)),
        read: (id) => guard(transport.operation(spaceId, id)),
      }),
    [spaceId, transport],
  );
  return useSeatChange(spaceId, create, transport.subscribe, gate);
}
