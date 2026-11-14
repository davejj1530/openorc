import { useState } from "react";
import type { OrganizationIdentity } from "@openorc/protocol";
import { TopBar } from "../components/TopBar";
import { Button } from "../components/ui";
import { OrganizationIdentityDialog } from "../dialogs/OrganizationIdentityDialog";
import { OrganizationMembershipDialog, type MembershipAction } from "../dialogs/OrganizationMembershipDialog";
import { cn } from "../lib/cn";
import { useOrganizationPeople } from "../lib/organization-people";
import { ORGANIZATION_SEATS_ENABLED, useOrganizationSection } from "../lib/organization-section";
import { OrganizationMoreMenu } from "./OrganizationMenus";
import { OrganizationPeopleContent, OrganizationPeopleHeading } from "./OrganizationPeopleContent";
import { OrganizationSections } from "./OrganizationSections";
import { OrganizationSeatsPage } from "./OrganizationSeatsPage";
import "./pages.css";
import "./organization-people.css";

type Action = MembershipAction | { kind: "edit"; organization: OrganizationIdentity };
interface Props {
  spaceId: string;
  onInvite(): void;
  onLeft(): void | Promise<void>;
}

/** People occupies the work column without adding or discarding conversation tabs. */
export function OrganizationPeople({ spaceId, onInvite, onLeft }: Props) {
  const people = useOrganizationPeople(spaceId);
  const [dialog, setDialog] = useState<{ action: Action; trigger: HTMLButtonElement | null } | null>(null);
  const data = people.data;
  const admin = data?.viewer.role === "admin";
  const sections = Boolean(admin && ORGANIZATION_SEATS_ENABLED);
  const section = useOrganizationSection(spaceId, sections);
  const open = (action: Action, trigger: HTMLButtonElement | null) => setDialog({ action, trigger });
  const close = () => {
    const trigger = dialog?.trigger;
    setDialog(null);
    requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus();
    });
  };
  const roster = data ? (
    <OrganizationPeopleContent
      people={data}
      spaceId={spaceId}
      editable={Boolean(admin && !people.error)}
      refresh={people.refetch}
      remove={(person, trigger) => open({ kind: "remove", organization: data.organization, person }, trigger)}
    />
  ) : null;
  return (
    <>
      <TopBar>{section.section === "seats" ? "Seats" : "People"}</TopBar>
      <div className={cn("page-column list-page people-column", sections && "seats-column")}>
        {data ? (
          <>
            <OrganizationPeopleHeading people={data}>
              {admin && section.section === "people" ? (
                <Button variant="primary" size="lg" disabled={Boolean(people.error)} onClick={onInvite}>
                  Invite people
                </Button>
              ) : null}
              <OrganizationMoreMenu people={data} disabled={Boolean(people.error)} onAction={(kind, trigger) => open({ kind, organization: data.organization }, trigger)} />
            </OrganizationPeopleHeading>
            {sections ? <OrganizationSections {...section}>{section.section === "seats" ? <OrganizationSeatsPage spaceId={spaceId} /> : roster}</OrganizationSections> : roster}
          </>
        ) : null}
        {people.loading ? <p className="people-read-state text-sm text-ink-3">Loading people…</p> : null}
        {people.error ? (
          <div className="people-read-state">
            <p className="organization-error" role="alert">
              {people.error.message}
            </p>
            <Button onClick={() => void people.refetch().catch(() => {})}>Try again</Button>
          </div>
        ) : null}
      </div>
      {dialog ? <PeopleDialog action={dialog.action} close={close} refresh={people.refetch} onLeft={onLeft} /> : null}
    </>
  );
}

function PeopleDialog({ action, close, refresh, onLeft }: { action: Action; close(): void; refresh(): Promise<void>; onLeft(): void | Promise<void> }) {
  if (action.kind === "edit")
    return (
      <OrganizationIdentityDialog
        open
        organization={action.organization}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        onSaved={refresh}
      />
    );
  return <OrganizationMembershipDialog action={action} onClose={close} onDone={action.kind === "remove" ? refresh : onLeft} />;
}
