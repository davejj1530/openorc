import { createContext, useContext } from "react";
import type { OrganizationPerson, OrganizationSeat, OrganizationSeatPreview, SeatAssignmentWork } from "@openorc/protocol";
import type { BillingScope } from "./organization-billing";
import type { OrganizationBillingViewState } from "./organization-billing-state";

export const SEAT_ASSIGNMENT_ENABLED = true;
export type SeatAction = "give" | "move" | "takeBack";
export type SeatDialog = { action: SeatAction; seatId: string; memberId?: string | null; work?: SeatAssignmentWork; preview?: OrganizationSeatPreview };
export interface SeatAdministration {
  scope: BillingScope;
  state: OrganizationBillingViewState;
  permitted: boolean;
  open(dialog: SeatDialog): void;
  /** What a running or finished change does, once this window has seen its preview. */
  change(work: SeatAssignmentWork): SeatAction | null;
}
/** The server's preview says what a change does: a free seat is given, a change with no one to receive it takes the seat back. */
export function seatChange(preview: OrganizationSeatPreview | null | undefined, fallback: SeatAction | null = null): SeatAction | null {
  if (!preview) return fallback;
  if (!preview.to) return "takeBack";
  return preview.seat.assignment.kind === "available" ? "give" : "move";
}

const changeWords = {
  give: { running: "Giving the seat", done: "Seat given" },
  move: { running: "Moving the seat", done: "Seat moved" },
  takeBack: { running: "Taking back the seat", done: "Seat taken back" },
};
export const seatChangeWords = (change: SeatAction | null) => (change ? changeWords[change] : { running: "Updating the seat", done: "Seat updated" });

export const SeatAdministrationContext = createContext<SeatAdministration | null>(null);
export const useSeatAdministration = () => useContext(SeatAdministrationContext);

export function seatActionReason(admin: SeatAdministration, action: SeatAction, seat?: OrganizationSeat): string | null {
  if (!admin.permitted) return "Only an admin can do that.";
  if (admin.state.error) return admin.state.error;
  const billing = admin.state.status?.billing;
  if (!billing) return "Read the seats again.";
  if (seat && admin.state.status?.assignments?.some((work) => work.request.seatId === seat.id && (!work.operation || work.operation.state === "pending"))) return "Moving the seat.";
  if (action !== "takeBack" && !["live", "ending"].includes(billing.subscription?.standing ?? "")) return "Pay for seats before giving one to a person.";
  if (action !== "takeBack" && seat?.retiresAt) return "This seat is ending.";
  return null;
}

export function personSeat(admin: SeatAdministration, person: OrganizationPerson): OrganizationSeat | undefined {
  return admin.state.status?.billing?.seats.find((seat) => seat.id === person.seat?.id);
}
