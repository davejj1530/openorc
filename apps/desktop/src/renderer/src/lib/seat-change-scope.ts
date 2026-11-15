import { useEffect, useState, useSyncExternalStore } from "react";
import type { OrganizationAccessStore } from "./organization-access-store";
import { billingIdentity } from "./organization-billing";
import { organizationContentGate, startOrganizationContentGate } from "./organization-content-gate";
import { SeatAdministrationLost } from "./seat-administration-lost";

interface Flow {
  refresh(): Promise<void>;
  revoke(): void;
  close(): void;
}
export interface SeatChangeLease {
  /** This admin still holds the authority the flow was opened with. */
  current(): boolean;
  /** Ends the flow when the core answers that the authority is gone. */
  guard<T>(read: Promise<T>): Promise<T>;
}

/**
 * One seat change flow for an organization's admin, bound to the same authority as billing, frozen admins included.
 * The flow is revoked the moment that authority is lost, and read again when the organization's seats change.
 * `create` and `subscribe` must keep their identity between renders.
 */
export function useSeatChange<F extends Flow>(
  spaceId: string,
  create: (lease: SeatChangeLease) => F,
  subscribe: (spaceId: string, refresh: () => void) => () => void,
  gate: OrganizationAccessStore = organizationContentGate,
  denied?: () => void,
): F | null {
  const snapshot = useSyncExternalStore(gate.subscribe, gate.getSnapshot);
  const identity = billingIdentity(gate, spaceId);
  const [scope, setScope] = useState<{ spaceId: string; identity: string; view: F } | null>(null);
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
    const view = create({ current, guard });
    setScope({ spaceId, identity, view });
    const protect = gate.subscribeProtected(() => {
      if (!current()) {
        live = false;
        view.revoke();
      }
    });
    const stop = subscribe(spaceId, () => void view.refresh());
    return () => {
      protect();
      stop();
      live = false;
      view.close();
    };
  }, [spaceId, identity, create, subscribe, gate, denied]);
  return snapshot.ready && scope?.spaceId === spaceId && scope.identity === identity ? scope.view : null;
}
