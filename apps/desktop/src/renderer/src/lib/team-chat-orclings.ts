import type { TeamChatTarget } from "@openorc/client";
import type { TeamChatOrclingPick, TeamOrclingCall } from "@openorc/protocol";
import type { TeamChatContextValue } from "./team-chat-context";
import { teamChat } from "./team-chat-queries";

/** The person's own Orclings a conversation can call, and the owner's way to try a call again; nothing where calls aren't available. */
export function useTeamChatOrclings(scope: TeamChatContextValue, target: TeamChatTarget, enabled: boolean, failed: (message: string) => void) {
  const picks = teamChat.useOrclingPicks(enabled);
  if (!enabled) return {};
  return {
    orclings: picks,
    onOrcling: (orcling: TeamChatOrclingPick) => teamChat.drafts.callOrcling(target, orcling),
    onRetryCall: (call: TeamOrclingCall) => {
      void teamChat.retryCall(scope, target, call).catch((error) => {
        if (scope.current()) failed(error instanceof Error ? error.message : `${call.name} couldn't be called again.`);
      });
    },
  };
}
