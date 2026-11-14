import { useCallback, useEffect, useRef, useState } from "react";
import type { ReceivedInvitation } from "@openorc/protocol";
import { core } from "./rpc";
import { useRpc } from "./client";

export interface InvitationDecision {
  invitation: ReceivedInvitation;
  pending: "join" | "decline" | null;
  detail: boolean;
  declined: boolean;
  joined: boolean;
  error: string | null;
}

/** An explicit Join may select a space; a live inbox update never does. */
export function useReceivedInvitations(onJoined: (spaceId: string, signal: AbortSignal) => Promise<void>, accountKey?: string) {
  const status = useRpc("spaces.status", {}).data;
  const latest = useRef(status);
  latest.current = status;
  const resumeAfter = useRef(0);
  const [decision, setDecision] = useState<InvitationDecision | null>(null);
  const request = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const joined = useRef<{ invitationId: string; spaceId: string } | null>(null);
  useEffect(() => {
    joined.current = null;
    setDecision(null);
    busy.current = false;
    return () => request.current?.abort();
  }, [accountKey]);
  const close = useCallback(() => {
    request.current?.abort();
    busy.current = false;
    setDecision(null);
  }, []);
  const open = (invitation: ReceivedInvitation) => {
    request.current?.abort();
    setDecision({ invitation, pending: null, detail: true, declined: false, joined: joined.current?.invitationId === invitation.id, error: null });
  };
  const respond = async (invitation: ReceivedInvitation, action: "join" | "decline", detail = false) => {
    if (busy.current) return;
    busy.current = true;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setDecision({ invitation, pending: action, detail, declined: false, joined: joined.current?.invitationId === invitation.id, error: null });
    try {
      if (action === "join") {
        if (joined.current?.invitationId !== invitation.id) {
          const { spaceId } = await core.call("spaces.invitation.accept", { invitationId: invitation.id });
          joined.current = { invitationId: invitation.id, spaceId };
        }
        if (controller.signal.aborted) return;
        await onJoined(joined.current.spaceId, controller.signal);
      } else await core.call("spaces.invitation.decline", { invitationId: invitation.id });
      if (controller.signal.aborted) return;
      setDecision(action === "decline" && detail ? { invitation, pending: null, detail: true, declined: true, joined: false, error: null } : null);
    } catch (error) {
      if (!controller.signal.aborted) {
        resumeAfter.current = latest.current?.state === "ready" ? latest.current.heardAt : 0;
        setDecision({
          invitation,
          pending: null,
          detail: true,
          declined: false,
          joined: joined.current?.invitationId === invitation.id,
          error: error instanceof Error ? error.message : "OpenOrc Cloud can't be reached.",
        });
      }
    } finally {
      if (request.current === controller) busy.current = false;
    }
  };
  useEffect(() => {
    if (
      decision?.joined &&
      decision.error &&
      !decision.pending &&
      status?.state === "ready" &&
      !status.error &&
      status.heardAt > resumeAfter.current &&
      status.spaces.some((space) => space.id === joined.current?.spaceId)
    )
      void respond(decision.invitation, "join", true);
  });
  const invitation = status?.state === "ready" ? status.invitations.find((invite) => invite.id === decision?.invitation.id) : undefined;
  return { decision: decision && invitation ? { ...decision, invitation } : decision, open, close, respond };
}

export type ReceivedInvitationActions = ReturnType<typeof useReceivedInvitations>;
export const inviterLine = (invitation: ReceivedInvitation) => (invitation.inviter.name ? `${invitation.inviter.name} invited you` : "You’re invited");
