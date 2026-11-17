import { useMemo } from "react";
import type { TeamChatOrclingPick, TeamOrclingCall } from "@openorc/protocol";
import { core } from "./rpc";
import { useRpc } from "./client";
import type { TeamChatContextValue } from "./team-chat-context";
import type { TeamChatTarget } from "./team-chat-draft";
import { teamChatDrafts } from "./team-chat-queries";

/** The person's own Orclings a conversation can call, and the owner's way to try a call again; nothing where calls aren't available. */
export function useTeamChatOrclings(scope: TeamChatContextValue, target: TeamChatTarget, enabled: boolean, failed: (message: string) => void) {
  const orclings = useRpc("orclings.list", {}, { enabled }).data;
  const picks = useMemo<TeamChatOrclingPick[]>(() => (orclings ?? []).map((orcling) => ({ localOrclingId: orcling.id, name: orcling.name, look: orcling.look })), [orclings]);
  if (!enabled) return {};
  return {
    orclings: picks,
    onOrcling: (orcling: TeamChatOrclingPick) => teamChatDrafts.callOrcling(target, orcling),
    onRetryCall: (call: TeamOrclingCall) => {
      void retryOrclingCall(scope, target, call).catch((error) => {
        if (scope.current()) failed(error instanceof Error ? error.message : `${call.name} couldn't be called again.`);
      });
    },
  };
}

export async function retryOrclingCall(scope: TeamChatContextValue, target: TeamChatTarget, call: TeamOrclingCall): Promise<void> {
  if (!scope.current() || scope.reach !== "live") throw new Error("You're offline. Reconnect to try again.");
  await core.call("teamChat.retryOrclingCall", { spaceId: target.spaceId, conversationId: target.conversationId, callId: call.id });
}
