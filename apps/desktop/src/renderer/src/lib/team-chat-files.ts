import { useMemo } from "react";
import type { HostedFileScope } from "@openorc/protocol";
import { useRpc } from "./client";
import type { TeamChatContextValue } from "./team-chat-context";

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
