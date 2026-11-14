import { useState } from "react";
import type { OrganizationIdentity } from "@openorc/protocol";
import { OrganizationMark } from "../components/OrganizationMark";
import { TopBar } from "../components/TopBar";
import { Button } from "../components/ui";
import { OrganizationIdentityDialog } from "../dialogs/OrganizationIdentityDialog";
import { OrganizationMembershipDialog, type MembershipAction } from "../dialogs/OrganizationMembershipDialog";
import { useRpc } from "../lib/client";
import { useOrganizationPeople } from "../lib/organization-people";
import { OrganizationMoreMenu } from "./OrganizationMenus";
import { OrganizationPeopleRow } from "./OrganizationPeopleRow";
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
  const projects = useRpc("spaces.projects", { spaceId });
  const [dialog, setDialog] = useState<{ action: Action; trigger: HTMLButtonElement | null } | null>(null);
  const data = people.data;
  const admin = data?.viewer.role === "admin";
  const projectCount = projects.data && !projects.error ? new Set(projects.data.map((project) => project.hostedProjectId ?? project.key)).size : undefined;
  const open = (action: Action, trigger: HTMLButtonElement | null) => setDialog({ action, trigger });
  const close = () => {
    const trigger = dialog?.trigger;
    setDialog(null);
    requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus();
    });
  };
  return (
    <>
      <TopBar>People</TopBar>
      <div className="page-column list-page people-column">
        {data ? (
          <>
            <div className="people-heading">
              <OrganizationMark name={data.organization.name} logo={data.organization.logo} size={44} />
              <div className="people-identity">
                <h1>{data.organization.name}</h1>
                <p>
                  {data.total} {data.total === 1 ? "person" : "people"}
                  {projectCount !== undefined ? ` · ${projectCount} project${projectCount === 1 ? "" : "s"}` : ""}
                </p>
              </div>
              {admin ? (
                <Button variant="primary" size="lg" disabled={Boolean(people.error)} onClick={onInvite}>
                  Invite people
                </Button>
              ) : null}
              <OrganizationMoreMenu people={data} disabled={Boolean(people.error)} onAction={(kind, trigger) => open({ kind, organization: data.organization }, trigger)} />
            </div>
            <div role="table" aria-label="People" className="people-roster">
              <div role="row" className="people-grid people-head">
                <span role="columnheader">Name</span>
                <span role="columnheader">Plan</span>
                <span role="columnheader">Role</span>
                <span role="columnheader" aria-label="Actions" />
              </div>
              <div role="rowgroup">
                {data.members.map((person) => (
                  <OrganizationPeopleRow
                    key={person.memberId}
                    person={person}
                    spaceId={spaceId}
                    self={person.memberId === data.viewer.memberId}
                    editable={Boolean(admin && !people.error && (person.memberId !== data.viewer.memberId || data.adminCount > 1))}
                    onChanged={people.refetch}
                    onRemove={(person, trigger) => open({ kind: "remove", organization: data.organization, person }, trigger)}
                  />
                ))}
              </div>
            </div>
          </>
        ) : null}
        {people.loading ? <p className="people-read-state text-sm text-ink-3">Loading people…</p> : null}
        {people.error ? (
          <div className="people-read-state">
            <p className="organization-error" role="alert">
              {people.error.message}
            </p>
            <Button onClick={() => void people.refetch()}>Try again</Button>
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
