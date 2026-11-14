import type { OrganizationPeople, OrganizationPerson } from "@openorc/protocol";
import type { ReactNode } from "react";
import { OrganizationMark } from "../components/OrganizationMark";
import { useRpc } from "../lib/client";
import { OrganizationPeopleRow } from "./OrganizationPeopleRow";
import { OrganizationInvitations } from "./OrganizationInvitations";

export function OrganizationPeopleHeading({ people, children }: { people: OrganizationPeople; children: ReactNode }) {
  const projects = useRpc("spaces.projects", { spaceId: people.organization.id });
  const projectCount = projects.data && !projects.error ? new Set(projects.data.map((project) => project.hostedProjectId ?? project.key)).size : undefined;
  return (
    <div className="people-heading">
      <OrganizationMark name={people.organization.name} logo={people.organization.logo} size={44} />
      <div className="people-identity">
        <h1>{people.organization.name}</h1>
        <p>
          {people.total} {people.total === 1 ? "person" : "people"}
          {projectCount !== undefined ? ` · ${projectCount} project${projectCount === 1 ? "" : "s"}` : ""}
        </p>
      </div>
      {children}
    </div>
  );
}

export function OrganizationPeopleContent({
  people,
  spaceId,
  editable,
  refresh,
  remove,
}: {
  people: OrganizationPeople;
  spaceId: string;
  editable: boolean;
  refresh(): Promise<void>;
  remove(person: OrganizationPerson, trigger: HTMLButtonElement | null): void;
}) {
  return (
    <>
      <div role="table" aria-label="People" className="people-roster">
        <div role="row" className="people-grid people-head">
          <span role="columnheader">Name</span>
          <span role="columnheader">Plan</span>
          <span role="columnheader">Role</span>
          <span role="columnheader" aria-label="Actions" />
        </div>
        <div role="rowgroup">
          {people.members.map((person) => (
            <OrganizationPeopleRow
              key={person.memberId}
              person={person}
              spaceId={spaceId}
              self={person.memberId === people.viewer.memberId}
              editable={editable && (person.memberId !== people.viewer.memberId || people.adminCount > 1)}
              onChanged={refresh}
              onRemove={remove}
            />
          ))}
        </div>
      </div>
      {people.viewer.role === "admin" ? <OrganizationInvitations spaceId={spaceId} /> : null}
    </>
  );
}
