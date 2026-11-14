import { Menu } from "@base-ui/react/menu";
import type { ReceivedInvitation } from "@openorc/protocol";
import { Button } from "./ui";
import { OrganizationMark } from "./OrganizationMark";
import { inviterLine, type ReceivedInvitationActions } from "../lib/received-invitations";
import "../dialogs/received-invitations.css";

export function ReceivedInvitationRow({ invitation, actions }: { invitation: ReceivedInvitation; actions: ReceivedInvitationActions }) {
  const pending = actions.decision?.invitation.id === invitation.id ? actions.decision.pending : null;
  const disabled = Boolean(actions.decision?.pending);
  return (
    <div className="organization-received-row">
      <OrganizationMark {...invitation.organization} size={24} />
      <Menu.Item className="organization-received-name" disabled={disabled} onClick={() => actions.open(invitation)}>
        <span>{invitation.organization.name}</span>
        <span className="organization-received-inviter">{inviterLine(invitation)}</span>
      </Menu.Item>
      <div className="organization-received-actions">
        <Menu.Item closeOnClick={false} render={<Button size="sm" />} disabled={disabled} onClick={() => void actions.respond(invitation, "join")}>
          {pending === "join" ? "Joining…" : "Join"}
        </Menu.Item>
        <Menu.Item closeOnClick={false} render={<Button size="sm" variant="ghost" />} disabled={disabled} onClick={() => void actions.respond(invitation, "decline")}>
          {pending === "decline" ? "Declining…" : "Decline"}
        </Menu.Item>
      </div>
    </div>
  );
}
