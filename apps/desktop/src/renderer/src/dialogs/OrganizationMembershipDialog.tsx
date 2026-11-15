import { useRef, useState } from "react";
import type { OrganizationIdentity, OrganizationPerson } from "@openorc/protocol";
import { AccountFace } from "../components/AccountFace";
import { OrganizationDeleteBillingRefusal, seatsHoldDeletion } from "../components/OrganizationDeleteBillingRefusal";
import { Button, Dialog, Input } from "../components/ui";
import { useRpcMutation } from "../lib/client";
import "../components/Organization.css";

export type MembershipAction = { kind: "remove"; organization: OrganizationIdentity; person: OrganizationPerson } | { kind: "leave" | "delete"; organization: OrganizationIdentity };
export const personFirstName = (person: Pick<OrganizationPerson, "name" | "email">) => person.name.trim().split(/\s+/)[0] || person.email;

interface Props {
  action: MembershipAction;
  onClose(): void;
  onDone(): void | Promise<void>;
  /** Where a deletion that the organization's seats refuse leads. */
  onManageSeats?(): void;
}

export function OrganizationMembershipDialog({ action, onClose, onDone, onManageSeats }: Props) {
  const remove = useRpcMutation("organization.member.remove");
  const leave = useRpcMutation("organization.leave");
  const destroy = useRpcMutation("organization.delete");
  const [confirmation, setConfirmation] = useState("");
  const submitting = useRef(false);
  const completed = useRef(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const pending = remove.isPending || leave.isPending || destroy.isPending || reading;
  const error = remove.error ?? leave.error ?? destroy.error;
  const words = actionWords(action);
  const submitLabel = membershipActionLabel(completed.current, pending, words);
  const held = seatsRoute(destroy.error, onManageSeats);
  const unconfirmed = action.kind === "delete" && confirmation.trim() !== action.organization.name;
  const submit = async () => {
    if (submitting.current) return;
    submitting.current = true;
    try {
      const spaceId = action.organization.id;
      if (!completed.current) {
        if (action.kind === "remove") await remove.mutateAsync({ spaceId, memberId: action.person.memberId });
        else if (action.kind === "leave") await leave.mutateAsync({ spaceId });
        else await destroy.mutateAsync({ spaceId, name: confirmation });
        completed.current = true;
      }
      setReading(true);
      await onDone();
      onClose();
    } catch (error) {
      if (completed.current) setReadError(error instanceof Error ? error.message : "OpenOrc Cloud can't be reached.");
    } finally {
      submitting.current = false;
      setReading(false);
    }
  };
  return (
    <Dialog
      open
      title={words.title}
      width={action.kind === "leave" ? 440 : 460}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <form
        className="organization-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <RemovedPerson action={action} />
        {!completed.current ? <p className="organization-membership-detail">{words.detail}</p> : null}
        {action.kind === "delete" && !held ? (
          <label className="organization-label">
            Type {action.organization.name} to confirm
            <Input
              variant="sheet"
              aria-label={`Type ${action.organization.name} to confirm`}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={pending || completed.current}
              autoFocus
            />
          </label>
        ) : null}
        <MembershipErrors action={action} readError={readError} error={error} />
        <div className="organization-actions">
          <Button disabled={pending} onClick={onClose}>
            {completed.current ? "Close" : "Cancel"}
          </Button>
          {held ? (
            <OrganizationDeleteBillingRefusal onManageSeats={held} />
          ) : (
            <Button type="submit" variant="primary" disabled={pending || unconfirmed}>
              {submitLabel}
            </Button>
          )}
        </div>
      </form>
    </Dialog>
  );
}

/** Who is being removed, when the dialog removes a person. */
function RemovedPerson({ action }: { action: MembershipAction }) {
  if (action.kind !== "remove") return null;
  return (
    <div className="organization-person-identity">
      <AccountFace name={action.person.name} image={action.person.image} />
      <div>
        {action.person.name}
        <p>{action.person.email}</p>
      </div>
    </div>
  );
}

/** Where to go when the organization's seats refuse its deletion; null for any other outcome. */
function seatsRoute(error: Error | null, onManageSeats: (() => void) | undefined): (() => void) | null {
  return onManageSeats && error && seatsHoldDeletion(error.message) ? onManageSeats : null;
}

function membershipActionLabel(completed: boolean, pending: boolean, words: ReturnType<typeof actionWords>) {
  if (pending) return completed ? "Trying…" : words.working;
  return completed ? "Try again" : words.action;
}

function actionWords(action: MembershipAction) {
  const name = action.organization.name;
  if (action.kind === "remove") {
    const first = personFirstName(action.person);
    return { title: `Remove ${first} from ${name}?`, detail: `${first} will lose access to ${name}'s projects and threads.`, action: `Remove ${first}`, working: "Removing…" };
  }
  if (action.kind === "leave") return { title: `Leave ${name}?`, detail: "You'll lose access to its projects and threads.", action: "Leave organization", working: "Leaving…" };
  return { title: `Delete ${name}?`, detail: "Its projects, threads, files and activity will be deleted for everyone. This can't be undone.", action: "Delete organization", working: "Deleting…" };
}

function completedWords(action: MembershipAction) {
  if (action.kind === "remove") return `${personFirstName(action.person)} was removed.`;
  if (action.kind === "leave") return `You left ${action.organization.name}.`;
  return `${action.organization.name} was deleted.`;
}

function MembershipErrors({ action, readError, error }: { action: MembershipAction; readError: string | null; error: Error | null }) {
  return (
    <>
      {readError ? (
        <>
          <p>{completedWords(action)}</p>
          <p role="alert" className="organization-error">
            {readError}
          </p>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="organization-error">
          {error.message}
        </p>
      ) : null}
    </>
  );
}
