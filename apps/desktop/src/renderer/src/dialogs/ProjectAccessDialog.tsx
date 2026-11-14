import { useRef, useState } from "react";
import type { OrganizationIdentity, OrganizationPeople, OrganizationProjectAccess, SpaceProject } from "@openorc/protocol";
import { AccountFace } from "../components/AccountFace";
import { Segmented } from "../components/Segmented";
import { Button, Checkbox, Dialog } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/client";
import { useOrganizationPeople } from "../lib/organization-people";
import "../components/Organization.css";

export function ProjectAccessDialog({ organization, project, onClose }: { organization: OrganizationIdentity; project: SpaceProject & { hostedProjectId: string }; onClose(): void }) {
  const read = useRpc("organization.project.access", { spaceId: organization.id, projectId: project.hostedProjectId });
  const people = useOrganizationPeople(organization.id);
  const pending = useRef(false);
  const error = read.error ?? people.error;
  return (
    <Dialog
      open
      title="Project access"
      width={520}
      onOpenChange={(open) => {
        if (!open && !pending.current) onClose();
      }}
    >
      {read.data && people.data && !people.loading ? (
        <AccessForm
          organization={organization}
          project={project}
          initial={read.data}
          people={people.data}
          onClose={onClose}
          onPending={(value) => {
            pending.current = value;
          }}
        />
      ) : (
        <div className="organization-form">
          <p className="text-sm text-ink-3">{error ? error.message : "Loading project access…"}</p>
          {error ? (
            <Button
              onClick={() => {
                void read.refetch();
                void people.refetch();
              }}
            >
              Try again
            </Button>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}

function AccessForm({
  organization,
  project,
  initial,
  people,
  onClose,
  onPending,
}: {
  organization: OrganizationIdentity;
  project: SpaceProject;
  initial: OrganizationProjectAccess;
  people: OrganizationPeople;
  onClose(): void;
  onPending(value: boolean): void;
}) {
  const [everyone, setEveryone] = useState(initial.everyone);
  const [chosen, setChosen] = useState(initial.memberIds);
  const change = useRpcMutation("organization.project.setAccess");
  const submitting = useRef(false);
  const admin = people.viewer.role === "admin";
  const submit = async () => {
    if (submitting.current || !admin) return;
    submitting.current = true;
    onPending(true);
    try {
      await change.mutateAsync({ spaceId: organization.id, projectId: initial.projectId, everyone, memberIds: chosen });
      onClose();
    } catch {
      /* Keep the chosen policy visible with the server's refusal. */
    } finally {
      submitting.current = false;
      onPending(false);
    }
  };
  return (
    <form
      className="organization-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="organization-access-project">
        {project.name}
        <span className="organization-small">{project.repo}</span>
      </div>
      <Segmented
        label="Who can use this project"
        value={everyone ? "everyone" : "chosen"}
        onChange={(value) => setEveryone(value === "everyone")}
        options={[
          { value: "everyone", label: `Everyone in ${organization.name}`, disabled: change.isPending || !admin },
          { value: "chosen", label: "Only people you choose", disabled: change.isPending || !admin },
        ]}
      />
      {!everyone ? (
        <div className="organization-access-people">
          {people.members.map((person) => (
            <label className="organization-access-person" key={person.memberId}>
              <Checkbox
                aria-label={person.name}
                checked={person.role === "admin" || chosen.includes(person.memberId)}
                disabled={person.role === "admin" || change.isPending || !admin}
                onChange={(event) => setChosen((ids) => (event.target.checked ? [...ids, person.memberId] : ids.filter((id) => id !== person.memberId)))}
              />
              <AccountFace name={person.name} image={person.image} />
              <span className="organization-access-name">
                {person.name}
                <span className="organization-small">{person.email}</span>
              </span>
              {person.role === "admin" ? <span className="organization-small">Admin</span> : null}
            </label>
          ))}
        </div>
      ) : null}
      <p className="organization-access-note">Admins always have access.</p>
      {change.error ? (
        <p role="alert" className="organization-error">
          {change.error.message}
        </p>
      ) : null}
      <div className="organization-actions">
        <Button disabled={change.isPending} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={change.isPending || !admin} data-tip={!admin ? "Only an admin can do that." : undefined}>
          {change.isPending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
