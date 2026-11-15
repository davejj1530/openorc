import { useRef, useState } from "react";
import type { OrganizationIdentity, OrganizationPerson, RpcParams, RpcResults } from "@openorc/protocol";
import { AccountFace } from "../components/AccountFace";
import { OrganizationDeleteBillingRefusal, deleteRefusalWords, type DeleteRefusal } from "../components/OrganizationDeleteBillingRefusal";
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
  const [refusal, setRefusal] = useState<DeleteRefusal | null>(null);
  const error = failure(refusal, remove.error ?? leave.error ?? destroy.error);
  const words = actionWords(action);
  const submitLabel = membershipActionLabel(completed.current, pending, words);
  const held = seatsRoute(refusal, onManageSeats);
  const unconfirmed = action.kind === "delete" && confirmation.trim() !== action.organization.name;
  const submit = async () => {
    if (submitting.current) return;
    submitting.current = true;
    try {
      if (!completed.current) {
        const refused = await carryOut(action, { remove: remove.mutateAsync, leave: leave.mutateAsync, destroy: destroy.mutateAsync }, confirmation);
        setRefusal(refused);
        if (refused) return;
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
        {held ? null : <ConfirmedName action={action} value={confirmation} onChange={setConfirmation} disabled={pending || completed.current} />}
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

/** A deletion is confirmed by typing the organization's name. */
function ConfirmedName({ action, value, onChange, disabled }: { action: MembershipAction; value: string; onChange(value: string): void; disabled: boolean }) {
  if (action.kind !== "delete") return null;
  return (
    <label className="organization-label">
      Type {action.organization.name} to confirm
      <Input variant="sheet" aria-label={`Type ${action.organization.name} to confirm`} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} autoFocus />
    </label>
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

interface Calls {
  remove(input: RpcParams<"organization.member.remove">): Promise<unknown>;
  leave(input: RpcParams<"organization.leave">): Promise<unknown>;
  destroy(input: RpcParams<"organization.delete">): Promise<RpcResults["organization.delete"]>;
}
/** Carries the action out. A deletion the organization's billing refuses is answered, not thrown: nothing was deleted. */
async function carryOut(action: MembershipAction, calls: Calls, confirmation: string): Promise<DeleteRefusal | null> {
  const spaceId = action.organization.id;
  if (action.kind === "remove") await calls.remove({ spaceId, memberId: action.person.memberId });
  else if (action.kind === "leave") await calls.leave({ spaceId });
  else return (await calls.destroy({ spaceId, name: confirmation })).refusal ?? null;
  return null;
}

/** Where a deletion the organization's billing refuses leads; null for any other outcome. */
const seatsRoute = (refusal: DeleteRefusal | null, onManageSeats: (() => void) | undefined): (() => void) | null => (refusal && onManageSeats ? onManageSeats : null);

/** What went wrong, in the server's words: its refusal of a deletion, or the failure of the call. */
const failure = (refusal: DeleteRefusal | null, error: Error | null): string | null => (refusal ? deleteRefusalWords(refusal) : (error?.message ?? null));

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

function MembershipErrors({ action, readError, error }: { action: MembershipAction; readError: string | null; error: string | null }) {
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
          {error}
        </p>
      ) : null}
    </>
  );
}
