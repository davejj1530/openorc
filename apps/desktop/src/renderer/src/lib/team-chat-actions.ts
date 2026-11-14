import type { PendingTeamMessage, TeamChatReaction, TeamMessage } from "@openorc/protocol";
import { core } from "./rpc";
import { receiveTeamMessage, teamChatDrafts } from "./team-chat-queries";
import type { TeamChatContextValue } from "./team-chat-context";
import type { TeamChatTarget } from "./team-chat-draft";

export async function sendTeamMessage(scope: TeamChatContextValue, target: TeamChatTarget, message: PendingTeamMessage): Promise<void> {
  if (!scope.current() || scope.reach !== "live") return;
  teamChatDrafts.attempt(target, message.id);
  try {
    const sent = await core.call("teamChat.send", {
      spaceId: target.spaceId,
      conversationId: target.conversationId,
      id: message.id,
      body: message.body,
      ...(message.files.length && { fileIds: message.files.map((file) => file.id) }),
    });
    if (!scope.current()) {
      teamChatDrafts.failed(target, message.id, "Delivery couldn't be confirmed.");
      return;
    }
    receiveTeamMessage(scope, sent);
  } catch (error) {
    teamChatDrafts.failed(target, message.id, error instanceof Error ? error.message : "Delivery couldn't be confirmed.");
  }
}

export async function reactToTeamMessage(scope: TeamChatContextValue, target: TeamChatTarget, message: TeamMessage, emoji: TeamChatReaction): Promise<void> {
  if (!scope.current() || scope.reach !== "live") throw new Error("You're offline. Reconnect to react.");
  const result = await core.call("teamChat.react", { spaceId: target.spaceId, conversationId: target.conversationId, messageId: message.id, emoji });
  if (scope.current()) receiveTeamMessage(scope, result);
}
