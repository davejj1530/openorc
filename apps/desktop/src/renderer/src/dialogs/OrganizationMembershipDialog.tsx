import { useRef, useState } from "react";
import type { OrganizationIdentity, OrganizationPerson } from "@openorc/protocol";
import { AccountFace } from "../components/AccountFace";
import { Button, Dialog, Input } from "../components/ui";
import { useRpcMutation } from "../lib/client";
import "../components/Organization.css";

export type MembershipAction = { kind: "remove"; organization: OrganizationIdentity; person: OrganizationPerson } | { kind: "leave" | "delete"; organization: OrganizationIdentity };
export const personFirstName = (person: Pick<OrganizationPerson, "name" | "email">) => person.name.trim().split(/\s+/)[0] || person.email;

export function OrganizationMembershipDialog({ action, onClose, onDone }: { action: MembershipAction; onClose(): void; onDone(): void | Promise<void> }) {
  const remove = useRpcMutation("organization.member.remove");
  const leave = useRpcMutation("organization.leave");
  const destroy = useRpcMutation("organization.delete");
  const [confirmation, setConfirmation] = useState("");
  const submitting = useRef(false);
  const pending = remove.isPending || leave.isPending || destroy.isPending;
  const error = remove.error ?? leave.error ?? destroy.error;
  const words = actionWords(action);
  const submit = async () => {
    if (submitting.current) return;
    submitting.current = true;
    try {
      const spaceId = action.organization.id;
      if (action.kind === "remove") await remove.mutateAsync({ spaceId, memberId: action.person.memberId });
      else if (action.kind === "leave") await leave.mutateAsync({ spaceId });
      else await destroy.mutateAsync({ spaceId, name: confirmation });
      await onDone();
      onClose();
    } catch {
      /* Refusals stay in the dialog with its confirmation text. */
    } finally {
      submitting.current = false;
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
        {action.kind === "remove" ? (
          <div className="organization-person-identity">
            <AccountFace name={action.person.name} image={action.person.image} />
            <div>
              {action.person.name}
              <p>{action.person.email}</p>
            </div>
          </div>
        ) : null}
        <p className="organization-membership-detail">{words.detail}</p>
        {action.kind === "delete" ? (
          <label className="organization-label">
            Type {action.organization.name} to confirm
            <Input
              variant="sheet"
              aria-label={`Type ${action.organization.name} to confirm`}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={pending}
              autoFocus
            />
          </label>
        ) : null}
        {error ? (
          <p role="alert" className="organization-error">
            {error.message}
          </p>
        ) : null}
        <div className="organization-actions">
          <Button disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={pending || (action.kind === "delete" && confirmation.trim() !== action.organization.name)}>
            {pending ? words.working : words.action}
          </Button>
        </div>
      </form>
    </Dialog>
  );
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
