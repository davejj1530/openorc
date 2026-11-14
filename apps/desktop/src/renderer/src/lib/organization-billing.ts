import { useEffect, useState, useSyncExternalStore } from "react";
import type { OrganizationBillingOffers, OrganizationBillingPage, OrganizationBillingStatus } from "@openorc/protocol";
import type { OrganizationAccessStore } from "./organization-access-store";
import { organizationContentGate, startOrganizationContentGate } from "./organization-content-gate";
import { OrganizationBillingView } from "./organization-billing-state";

export interface OrganizationBillingTransport {
  get(spaceId: string): Promise<OrganizationBillingStatus>;
  offers(spaceId: string, seats: number): Promise<OrganizationBillingOffers>;
  open(spaceId: string, target: OrganizationBillingPage): Promise<OrganizationBillingStatus>;
  leave(spaceId: string): Promise<OrganizationBillingStatus>;
  subscribe(spaceId: string, refresh: () => void): () => void;
}
export interface BillingScope {
  spaceId: string;
  identity: string;
  view: OrganizationBillingView;
  offers(spaceId: string, seats: number): Promise<OrganizationBillingOffers>;
}

/** Frozen admins retain billing recovery. Membership and account authority still bind every result. */
export function useOrganizationBilling(spaceId: string, transport: OrganizationBillingTransport, gate = organizationContentGate): BillingScope | null {
  const snapshot = useSyncExternalStore(gate.subscribe, gate.getSnapshot);
  const identity = billingIdentity(gate, spaceId);
  const [scope, setScope] = useState<BillingScope | null>(null);
  useEffect(() => (gate === organizationContentGate ? startOrganizationContentGate() : undefined), [gate]);
  useEffect(() => {
    if (!identity) return;
    let live = true;
    const current = () => live && billingIdentity(gate, spaceId) === identity;
    const view = new OrganizationBillingView({
      current,
      get: () => transport.get(spaceId),
      open: (target) => transport.open(spaceId, target),
      leave: () => transport.leave(spaceId),
    });
    setScope({ spaceId, identity, view, offers: scopedOffers(spaceId, current, transport) });
    const protect = gate.subscribeProtected(() => {
      if (!current()) {
        live = false;
        view.revoke();
      }
    });
    const stop = transport.subscribe(spaceId, () => void view.refresh());
    void view.refresh();
    return () => {
      protect();
      stop();
      view.close();
      live = false;
    };
  }, [spaceId, identity, transport, gate]);
  return snapshot.ready && scope?.spaceId === spaceId && scope.identity === identity ? scope : null;
}

export function billingIdentity(gate: OrganizationAccessStore, spaceId: string): string | null {
  const snapshot = gate.getSnapshot();
  if (!snapshot.ready || !snapshot.identity) return null;
  return snapshot.spaces.some((space) => space.id === spaceId && space.kind === "organization" && space.role === "admin") ? snapshot.identity : null;
}

function scopedOffers(spaceId: string, current: () => boolean, transport: OrganizationBillingTransport) {
  return async (requestedSpace: string, seats: number): Promise<OrganizationBillingOffers> => {
    if (requestedSpace !== spaceId || !current()) throw new Error("Your organization access changed. Try again.");
    const offers = await transport.offers(spaceId, seats);
    if (!current()) throw new Error("Your organization access changed. Try again.");
    return offers;
  };
}
