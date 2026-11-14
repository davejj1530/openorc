import type { TeamChatRoute } from "../lib/team-chat-route";
import { useOrganizationContentGate } from "../lib/organization-content-gate";
import { CoversPreview } from "../lib/browser-preview";
import { useTeamChatVisible } from "../lib/team-chat-visibility";
import { TeamChatView } from "../views/TeamChatView";
import { OrganizationAccessGate } from "./OrganizationAccessGate";

/** Frozen content uses the same recovery surface as the rest of the organization. */
export function ProtectedTeamChat({ target }: { target: TeamChatRoute }) {
  const access = useOrganizationContentGate(target.spaceId);
  const visible = useTeamChatVisible();
  if (access.allowed) return <TeamChatView target={target} />;
  return (
    <main className="workspace-main team-chat well flex flex-1 flex-col min-w-0 min-h-0">
      {visible ? <CoversPreview /> : null}
      <OrganizationAccessGate spaceId={target.spaceId}>{null}</OrganizationAccessGate>
    </main>
  );
}
