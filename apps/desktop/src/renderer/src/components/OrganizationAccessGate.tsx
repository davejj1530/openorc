import type { OrganizationIdentity, OrganizationAccess } from "@openorc/protocol";
import type { ReactNode } from "react";
import { organizationContentGate, useOrganizationContentGate } from "../lib/organization-content-gate";
import { useRouter } from "../lib/router";
import { OrganizationMark } from "./OrganizationMark";
import { TopBar } from "./TopBar";
import { Button } from "./ui";
import "../styles/organization-access.css";

/** Replace the entire protected work surface, including its toolbar and cached body. */
export function OrganizationAccessGate({ spaceId, children }: { spaceId: string | null; children: ReactNode }) {
  const gate = useOrganizationContentGate(spaceId);
  if (gate.allowed) return <>{children}</>;
  if (gate.blocked === "frozen" && gate.space?.kind === "organization" && gate.access?.state === "frozen")
    return <FrozenOrganization organization={gate.space} access={gate.access} onAccount={() => useRouter.getState().navigate({ view: "settings", section: "account" })} />;
  return (
    <div className="organization-access-read" role="status">
      {gate.blocked === "loading" && !gate.error ? (
        <span>Loading organization…</span>
      ) : (
        <>
          <span>{gate.blocked === "membership" ? "You no longer have access to this organization." : (gate.error ?? "Organization access could not be checked.")}</span>
          <Button onClick={() => void organizationContentGate.refresh()}>Try again</Button>
        </>
      )}
    </div>
  );
}

/** The private reason stays on this person's screen, never a shared transcript or activity event. */
export function FrozenOrganization({
  organization,
  access,
  onAccount,
  menu,
}: {
  organization: OrganizationIdentity;
  access: Extract<OrganizationAccess, { state: "frozen" }>;
  onAccount(): void;
  /** The organization page's "…", in the same place as on that page. */
  menu?: ReactNode;
}) {
  return (
    <>
      <TopBar orcling={false}>{organization.name}</TopBar>
      {menu ? (
        <div className="page-column list-page organization-frozen-head">
          <span className="organization-frozen-menu">{menu}</span>
        </div>
      ) : null}
      <section className="organization-frozen" aria-label={organization.name}>
        <div className="organization-frozen-content">
          <OrganizationMark name={organization.name} logo={organization.logo} size={40} />
          <h1>{organization.name}</h1>
          <p>{access.message}</p>
          <Button variant="primary" onClick={onAccount}>
            Upgrade to Pro
          </Button>
        </div>
      </section>
    </>
  );
}
