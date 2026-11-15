import { SeatQuantityPreview, SeatQuantityWork, type SeatQuantityRequest } from "@openorc/protocol";
import { SeatChangeFlow, type SeatChangeDeps, type SeatChangeKind, type SeatChangeState } from "./seat-change-flow";

export type SeatQuantityState = SeatChangeState<number, SeatQuantityPreview, SeatQuantityWork>;
export type SeatQuantityDeps = SeatChangeDeps<number, SeatQuantityPreview, SeatQuantityRequest, SeatQuantityWork>;

const kind: SeatChangeKind<number, SeatQuantityPreview, SeatQuantityRequest, SeatQuantityWork> = {
  preview: SeatQuantityPreview,
  work: SeatQuantityWork,
  answers: (preview, seats) => preview.to === seats,
  request: (preview, id) => ({ seats: preview.to, body: { id, previewToken: preview.token } }),
  target: (preview, work) => (preview.to === work.request.seats ? preview.to : null),
  stale: "The seats have changed. Review the change again.",
};

/** Changing how many seats an organization pays for. */
export class SeatQuantity extends SeatChangeFlow<number, SeatQuantityPreview, SeatQuantityRequest, SeatQuantityWork> {
  constructor(deps: SeatQuantityDeps) {
    super(kind, deps);
  }
}

/** What the server's review does: more seats now, fewer at renewal, none after the paid period, or the same number kept. */
export type QuantityChange = "add" | "reduce" | "end" | "keep";
export function quantityChange(preview: Pick<SeatQuantityPreview, "from" | "to">): QuantityChange {
  if (preview.to > preview.from) return "add";
  if (preview.to === 0) return "end";
  return preview.to < preview.from ? "reduce" : "keep";
}

const HOUR = 3600;
/** A seat's part month of hours, to the minute: "53 h 20 min". */
export function hoursAndMinutes(seconds: number): string {
  const hours = Math.floor(seconds / HOUR);
  const minutes = Math.floor((seconds % HOUR) / 60);
  if (!minutes) return `${hours} h`;
  return hours ? `${hours} h ${minutes} min` : `${minutes} min`;
}

/**
 * The server's sentence for a payment the provider refused. Only its words cross from the core, so the sentence's
 * opening is what tells a change that needs the organization's billing from one that only needs reviewing again.
 */
const PAYMENT_REFUSED = "The payment for these seats didn't go through.";
export const needsBilling = (message: string | null | undefined): boolean => Boolean(message?.startsWith(PAYMENT_REFUSED));
