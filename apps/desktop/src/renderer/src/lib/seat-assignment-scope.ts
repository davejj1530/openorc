import type { OrganizationSeatPreview, SeatAssignmentRequest, SeatAssignmentTarget, SeatAssignmentWork } from "@openorc/protocol";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { OrganizationAccessStore } from "./organization-access-store";
import { organizationContentGate, startOrganizationContentGate } from "./organization-content-gate";
import { billingIdentity } from "./organization-billing";
import { SeatAssignment } from "./seat-assignment";
import { SeatAdministrationLost } from "./seat-administration-lost";

export interface SeatAssignmentTransport {
  preview(spaceId: string, target: SeatAssignmentTarget): Promise<OrganizationSeatPreview>;
  assign(spaceId: string, request: SeatAssignmentRequest): Promise<SeatAssignmentWork>;
  operation(spaceId: string, id: string): Promise<SeatAssignmentWork | null>;
  subscribe(spaceId: string, refresh: () => void): () => void;
}

/** Seat recovery uses the same admin authority as billing, including frozen administrators. */
export function useSeatAssignment(spaceId: string, transport: SeatAssignmentTransport, gate: OrganizationAccessStore = organizationContentGate, denied?: () => void): SeatAssignment | null {
  const snapshot = useSyncExternalStore(gate.subscribe, gate.getSnapshot);
  const identity = billingIdentity(gate, spaceId);
  const [scope, setScope] = useState<{ spaceId: string; identity: string; view: SeatAssignment } | null>(null);
  useEffect(() => (gate === organizationContentGate ? startOrganizationContentGate() : undefined), [gate]);
  useEffect(() => {
    if (!identity) return;
    let live = true;
    const current = () => live && billingIdentity(gate, spaceId) === identity;
    const guard = <T>(read: Promise<T>): Promise<T> =>
      read.catch((error: unknown) => {
        if (error instanceof SeatAdministrationLost) {
          live = false;
          view.revoke();
          denied?.();
        }
        throw error;
      });
    const view = new SeatAssignment({
      current,
      now: Date.now,
      id: () => crypto.randomUUID(),
      preview: (target) => guard(transport.preview(spaceId, target)),
      send: (request) => guard(transport.assign(spaceId, request)),
      read: (id) => guard(transport.operation(spaceId, id)),
    });
    setScope({ spaceId, identity, view });
    const protect = gate.subscribeProtected(() => {
      if (!current()) {
        live = false;
        view.revoke();
      }
    });
    const stop = transport.subscribe(spaceId, () => void view.refresh());
    return () => {
      protect();
      stop();
      live = false;
      view.close();
    };
  }, [spaceId, identity, transport, gate, denied]);
  return snapshot.ready && scope?.spaceId === spaceId && scope.identity === identity ? scope.view : null;
}
