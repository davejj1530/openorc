import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { OrganizationSeat, OrganizationSeatPreview } from "@openorc/protocol";
import { useOrganizationBilling, type BillingScope } from "../lib/organization-billing";
import { organizationBillingTransport } from "../lib/organization-billing-rpc";
import { useOrganizationPeople } from "../lib/organization-people";
import { organizationContentGate } from "../lib/organization-content-gate";
import { useSeatAssignment } from "../lib/seat-assignment-scope";
import { seatAssignmentTransport } from "../lib/seat-assignment-rpc";
import { SEAT_ASSIGNMENT_ENABLED, SeatAdministrationContext, seatChange, type SeatDialog } from "../lib/seat-administration";
import { SeatAssignmentDialog } from "../dialogs/SeatAssignmentDialog";
import { SeatPersonDialog } from "../dialogs/SeatPersonDialog";
import type { SeatAssignmentState } from "../lib/seat-assignment";

export function OrganizationSeatAdministration({ spaceId, children }: { spaceId: string; children: ReactNode }) {
  return SEAT_ASSIGNMENT_ENABLED ? <SeatAuthority spaceId={spaceId}>{children}</SeatAuthority> : children;
}

function SeatAuthority({ spaceId, children }: { spaceId: string; children: ReactNode }) {
  const scope = useOrganizationBilling(spaceId, organizationBillingTransport);
  return scope ? (
    <SeatScope key={`${spaceId}:${scope.identity}`} scope={scope}>
      {children}
    </SeatScope>
  ) : (
    children
  );
}

function SeatScope({ scope, children }: { scope: BillingScope; children: ReactNode }) {
  const state = useSyncExternalStore(scope.view.subscribe, scope.view.getSnapshot);
  const [dialog, setDialog] = useState<SeatDialog | null>(null);
  const [denied, setDenied] = useState(false);
  const deniedBilling = useRef(state.status?.billing);
  const deniedNow = useRef(false);
  const previews = useRef(new Map<string, OrganizationSeatPreview>());
  const refuse = useCallback(() => {
    deniedNow.current = true;
    deniedBilling.current = scope.view.getSnapshot().status?.billing;
    setDenied(true);
    setDialog(null);
    previews.current.clear();
    void scope.view.refresh();
    void organizationContentGate.refresh();
  }, [scope]);
  useEffect(() => {
    if (denied && state.status?.billing && !state.error && state.status.billing !== deniedBilling.current) {
      deniedNow.current = false;
      setDenied(false);
    }
  }, [denied, state]);
  const permitted = !denied && Boolean(state.status?.billing);
  useEffect(() => {
    if (!permitted) previews.current.clear();
  }, [permitted]);
  const open = (next: SeatDialog) => {
    if (!deniedNow.current && permitted) setDialog({ ...next, preview: next.work ? previews.current.get(next.work.request.body.id) : undefined });
  };
  const close = (closed?: SeatAssignmentState) => {
    if (closed?.work && closed.preview && !deniedNow.current) previews.current.set(closed.work.request.body.id, closed.preview);
    setDialog(null);
  };
  return (
    <SeatAdministrationContext value={{ scope, state, permitted, open, change: (work) => seatChange(previews.current.get(work.request.body.id)) }}>
      {children}
      {dialog && permitted ? (
        <SeatFlow key={JSON.stringify(dialog)} spaceId={scope.spaceId} seat={state.status?.billing?.seats.find((seat) => seat.id === dialog.seatId)} dialog={dialog} close={close} denied={refuse} />
      ) : null}
    </SeatAdministrationContext>
  );
}

function SeatFlow({ spaceId, seat, dialog, close, denied }: { spaceId: string; seat?: OrganizationSeat; dialog: SeatDialog; close(state?: SeatAssignmentState): void; denied(): void }) {
  const people = useOrganizationPeople(spaceId);
  const [memberId, setMemberId] = useState(dialog.memberId);
  const view = useSeatAssignment(spaceId, seatAssignmentTransport, organizationContentGate, denied);
  useEffect(() => {
    if (!view) return;
    if (dialog.work) view.resume(dialog.work, dialog.preview);
    else if (memberId !== undefined) {
      view.select({ seatId: dialog.seatId, memberId });
      void view.review();
    }
  }, [view, dialog, memberId]);
  if (!view) return null;
  if (!dialog.work && memberId === undefined) {
    if (!seat) return null;
    return <SeatPersonDialog seat={seat} people={people.data?.members ?? []} onClose={close} onReview={setMemberId} />;
  }
  const recipientPaysForPro = people.data?.members.find((person) => person.memberId === memberId)?.seat?.paysForPro === true;
  return <SeatAssignmentDialog action={dialog.action} view={view} onClose={() => close(view.getSnapshot())} recipientPaysForPro={recipientPaysForPro} />;
}
