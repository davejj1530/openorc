import { useMemo } from "react";
import type { HostedFileScope } from "@openorc/protocol";
import { useRpc } from "./client";
import type { TeamChatContextValue } from "./team-chat-context";
import type { TeamChatComposerFiles } from "../components/TeamChatComposerFiles";
import { useOrganization } from "./organization-context";
import { useRouter } from "./router";

/** The uploads module's refusal when the organization's pooled storage has no room; the server's own words. */
export const STORAGE_FULL = "There isn't enough storage in this organization for this file.";

/** Where a conversation's files upload: this account, this organization, this conversation, and nowhere else. */
export function useTeamChatFileScope(scope: TeamChatContextValue, conversationId: string, enabled: boolean): HostedFileScope | null {
  const status = useRpc("spaces.status", {}, { enabled }).data;
  return useMemo(
    () =>
      enabled && status?.state === "ready" && status.userId === scope.accountId
        ? { apiOrigin: status.apiOrigin, accountId: scope.accountId, spaceId: scope.spaceId, destination: { kind: "chat", conversationId } }
        : null,
    [enabled, status, scope.accountId, scope.spaceId, conversationId],
  );
}

/** A conversation's own file draft, separate per account, organization and conversation. */
export const teamChatFilesDraftKey = (scope: Pick<TeamChatContextValue, "accountId" | "spaceId">, conversationId: string) =>
  `team-chat-files:${JSON.stringify([scope.accountId, scope.spaceId, conversationId])}`;

/** Where the composer attaches a conversation's files, with the admin's way to more storage; null without files here. */
export function useTeamChatFilePlace(scope: TeamChatContextValue, conversationId: string, enabled: boolean): TeamChatComposerFiles | null {
  const fileScope = useTeamChatFileScope(scope, conversationId, enabled);
  const organization = useOrganization()?.organization;
  if (!fileScope) return null;
  return {
    scope: fileScope,
    draftKey: teamChatFilesDraftKey(scope, conversationId),
    organization: organization?.name ?? "This organization",
    ...(organization?.role === "admin" && { addSeats: () => useRouter.getState().navigate({ view: "people", spaceId: scope.spaceId, section: "seats" }) }),
  };
}
