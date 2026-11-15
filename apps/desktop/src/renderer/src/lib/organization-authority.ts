import { useLayoutEffect, useRef } from "react";
import type { OrganizationSpace } from "@openorc/protocol";
import { queryClient, runs } from "./client";
import { organizationContentGate, useOrganizationContentGate } from "./organization-content-gate";
import type { OrganizationDialog } from "./organization-context";
import { protectOrganizationContent } from "./organization-frozen-content";
import { spaceNavigation } from "./space-navigation";
import { closeWorkOverlays } from "./work-overlays";

/**
 * This window's standing in the selected organization. Mounted once for the window, it also removes an organization's
 * content the moment it closes, and closes a dialog the person may no longer use.
 */
export function useOrganizationAuthority(organization: OrganizationSpace | null, dialog: OrganizationDialog | null, close: () => void) {
  const gate = useOrganizationContentGate(organization?.id ?? null);
  useLayoutEffect(
    () =>
      protectOrganizationContent({
        gate: organizationContentGate,
        queries: queryClient,
        runs,
        navigation: spaceNavigation,
        overlays: { close: closeWorkOverlays },
        storage: { keys: () => Object.keys(localStorage), removeItem: (key) => localStorage.removeItem(key) },
      }),
    [],
  );
  const frozen = gate.blocked === "frozen";
  const admin = organization?.role === "admin";
  const manages = admin && !frozen;
  // A frozen admin still invites, with a seat for every address; the organization's projects wait for their access.
  const open = { projects: manages, invite: admin, create: true };
  const held = dialog ? open[dialog.kind] : true;
  const closing = useRef(close);
  closing.current = close;
  useLayoutEffect(() => {
    if (!held) closing.current();
  }, [held]);
  /** `generation` moves whenever the gate's authority does: the spaces are reconciled again on each move. */
  return { frozen, manages, invites: admin, generation: gate.generation };
}

/** This person's private words for why the organization is frozen to them; nothing while it is open. */
export function useFrozenReason(spaceId: string): string | undefined {
  const gate = useOrganizationContentGate(spaceId);
  return gate.blocked === "frozen" && gate.access?.state === "frozen" ? gate.access.message : undefined;
}
