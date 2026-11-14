import { useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { queryClient, useRpc } from "../lib/client";
import { organizationContentGate, useOrganizationContentGate } from "../lib/organization-content-gate";
import { spaceNavigation, useSpaceNavigation } from "../lib/space-navigation";
import { TeamChatContext } from "../lib/team-chat-context";
import { TeamChatProtection } from "../lib/team-chat-protection";
import { teamChatDrafts } from "../lib/team-chat-queries";
import { teamChatClosedGroups } from "../lib/team-chat-group-preferences";

/** A server capability is read only after this account's organization access is current. */
export function TeamChatProvider({ children }: { children: ReactNode }) {
  const spaceId = useSpaceNavigation((state) => state.current);
  const status = useRpc("spaces.status", {}).data;
  useOrganizationContentGate(spaceId);
  const [protection] = useState(
    () => new TeamChatProtection({ gate: organizationContentGate, navigation: spaceNavigation, queries: queryClient, drafts: teamChatDrafts, closedGroups: teamChatClosedGroups }),
  );
  useSyncExternalStore(protection.subscribe, protection.getSnapshot);
  useLayoutEffect(() => protection.connect(), [protection]);
  const scope = protection.scope(status, spaceId);
  return <TeamChatContext value={scope}>{children}</TeamChatContext>;
}
