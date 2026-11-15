import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { OrganizationSaved } from "../dialogs/OrganizationIdentityDialog";
import { queryClient, useRpc } from "./client";
import { core } from "./rpc";
import { useSpacesStatus } from "./spaces-status";
import { reconcileSpaceNavigation } from "./space-queries";
import { spaceNavigation, useSpaceNavigation } from "./space-navigation";
import { useReceivedInvitations } from "./received-invitations";
import { useRouter } from "./router";
import { dismissCompactNavigation } from "./compact-navigation";
import type { OrganizationActions, OrganizationDialog } from "./organization-context";
import { useOrganizationAuthority } from "./organization-authority";

export function useOrganizationController() {
  const read = useSpacesStatus();
  const account = useRpc("account.status", {}).data;
  const identity = useRpc("system.info", { refresh: false }).data?.dataDir;
  const current = useSpaceNavigation((state) => state.current);
  const status = read.data;
  const data = status?.state === "ready" ? status : null;
  const selected = data?.spaces.find((space) => space.id === current);
  const organization = selected?.kind === "organization" ? selected : null;
  const signedIn = account?.state === "signed-in";
  const accountKey = signedIn ? `${identity}:${account.email}` : account?.state;
  const previousAccount = useRef(accountKey);
  const previousSpace = useRef(current);
  const latest = useRef(accountKey);
  latest.current = accountKey;
  const [dialog, setDialog] = useState<OrganizationDialog | null>(null);
  const [logos, setLogos] = useState<Record<string, string>>({});
  const close = () => setDialog(null);
  const refresh = async () => {
    const status = await core.call("spaces.refresh", {});
    if (latest.current !== accountKey) throw new Error("Your OpenOrc session changed. Try again.");
    if (status.state !== "ready" || status.error) throw new Error(("error" in status && status.error) || "OpenOrc Cloud can't be reached.");
    if (!identity) throw new Error("OpenOrc is still starting.");
    await reconcileSpaceNavigation(status, identity);
    queryClient.setQueryData(["spaces.status", {}], status);
  };
  const select = (id: string) => {
    close();
    invitations.close();
    spaceNavigation.getState().select(id);
    dismissCompactNavigation();
  };
  const invitations = useReceivedInvitations(async (id, signal) => {
    await refresh();
    if (!signal.aborted && latest.current === accountKey) select(id);
  }, accountKey);
  const closeInvitations = invitations.close;
  useLayoutEffect(() => {
    const changedAccount = previousAccount.current !== accountKey;
    const changedSpace = previousSpace.current !== null && previousSpace.current !== current;
    previousAccount.current = accountKey;
    previousSpace.current = current;
    if (changedAccount && spaceNavigation.getState().key) spaceNavigation.getState().end();
    if (changedAccount || changedSpace) {
      close();
      closeInvitations();
    }
  }, [current, accountKey, closeInvitations]);
  const authority = useOrganizationAuthority(organization, dialog, close);
  const error = useSpaceReconciliation(status, identity, authority.generation);
  const saved = async (result: OrganizationSaved, signal: AbortSignal) => {
    const pendingLogo = result.pendingLogo;
    if (pendingLogo) setLogos((logos) => ({ ...logos, [result.spaceId]: pendingLogo }));
    await refresh();
    if (!signal.aborted && latest.current === accountKey) select(result.spaceId);
  };
  const actions: OrganizationActions = {
    status,
    signedIn,
    person: signedIn ? (account.name ?? account.email) : "",
    organization,
    invitations,
    dialog,
    pendingLogo: organization ? (logos[organization.id] ?? null) : null,
    error: error ?? read.error?.message ?? (status && "error" in status ? status.error : null),
    close,
    select,
    refresh,
    create: () => {
      if (signedIn && data?.create.allowed) setDialog({ kind: "create" });
    },
    invite: () => {
      if (organization && authority.invites) setDialog({ kind: "invite", organization });
    },
    addProjects: () => {
      if (organization && authority.manages) setDialog({ kind: "projects", spaceId: organization.id });
    },
    people: (section) => {
      if (!organization) return;
      close();
      useRouter.getState().navigate({ view: "people", spaceId: organization.id, ...(section && { section }) });
      dismissCompactNavigation();
    },
    logoSaved: () => {
      if (organization) setLogos((logos) => ({ ...logos, [organization.id]: "" }));
    },
  };
  return { actions, saved, accountKey };
}

/** `authority` is the gate's generation: a deadline that passes or access that returns changes no status, yet both read the spaces again. */
function useSpaceReconciliation(status: ReturnType<typeof useSpacesStatus>["data"], identity: string | undefined, authority: number) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!status || !identity) return;
    let active = true;
    void reconcileSpaceNavigation(status, identity).then(
      () => {
        if (active) setError(null);
      },
      (error: unknown) => {
        if (active) setError(error instanceof Error ? error.message : "OpenOrc Cloud can't be reached.");
      },
    );
    return () => {
      active = false;
    };
  }, [status, identity, authority]);
  return error;
}
