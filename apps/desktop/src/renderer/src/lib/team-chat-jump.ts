import { useEffect } from "react";
import { create } from "zustand";
import type { TeamChatTarget } from "./team-chat-draft";

/** A message to show in its conversation: a reply's answered message, a pin or a search result. */
export interface TeamChatJump {
  key: string;
  id: string;
  seq: number;
  nonce: number;
}
const keyOf = (target: TeamChatTarget) => JSON.stringify([target.accountId, target.spaceId, target.conversationId]);
let nonce = 0;

export const useTeamChatJump = create<{ jump: TeamChatJump | null }>(() => ({ jump: null }));

export function jumpToTeamMessage(target: TeamChatTarget, message: { id: string; seq: number }): void {
  useTeamChatJump.setState({ jump: { key: keyOf(target), id: message.id, seq: message.seq, nonce: ++nonce } });
}

/** Clears the request once its conversation showed the message, or found it gone. */
export function teamMessageJumped(done: number): void {
  if (useTeamChatJump.getState().jump?.nonce === done) useTeamChatJump.setState({ jump: null });
}

export function useTeamChatJumpFor(target: TeamChatTarget): TeamChatJump | null {
  return useTeamChatJump((state) => (state.jump?.key === keyOf(target) ? state.jump : null));
}

/**
 * Pages back until a requested message is on the page, then names it for the transcript to show. The page stays one
 * window to the latest message, as the reading place does. A message no longer there ends the request quietly.
 */
export function useTeamMessageReveal({
  target,
  page,
  paging,
  failed,
  loadOlder,
}: {
  target: TeamChatTarget;
  page: { messages: readonly { id: string; seq: number }[]; older: boolean } | undefined;
  paging: boolean;
  /** A page failed with its notice: none is loaded again until it is dismissed. */
  failed: boolean;
  loadOlder(): void;
}) {
  const jump = useTeamChatJumpFor(target);
  const messages = page?.messages ?? [];
  const older = page?.older ?? false;
  const present = jump ? messages.some((message) => message.id === jump.id) : false;
  const reached = present || !older || (messages[0] !== undefined && messages[0].seq <= (jump?.seq ?? 0));
  useEffect(() => {
    if (!jump || messages.length === 0) return;
    if (!reached && !paging && !failed) loadOlder();
    else if (reached && !present) teamMessageJumped(jump.nonce);
    // `loadOlder` is recreated each render; the page it loads changes `reached`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump, reached, present, paging, failed, messages.length]);
  return { reveal: jump && present ? { id: jump.id, nonce: jump.nonce } : null, onRevealed: teamMessageJumped };
}
