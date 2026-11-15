import type { OrganizationSeat } from "@openorc/protocol";

export interface InvitationSeatChoice {
  /** The seat each address holds, by address. An address without one is invited with no seat. */
  seats: Record<string, string>;
  /** The seats free to hold before this draft takes any. */
  free: number;
}

const usable = (seat: OrganizationSeat): boolean => seat.assignment.kind === "available" && seat.retiresAt === null;
/** Fullest first, then by seat id; a seat whose hours are not known comes last, never counted as full. */
const fullestFirst = (a: OrganizationSeat, b: OrganizationSeat): number => (b.included?.leftSeconds ?? -1) - (a.included?.leftSeconds ?? -1) || (a.id < b.id ? -1 : Number(a.id > b.id));

/**
 * The seats a draft's addresses hold. An address keeps the seat it had while that seat is still free, so a retry sends
 * the same choice; one whose seat is gone picks again. No seat is ever given to two addresses, and none beyond the
 * free ones. The server still decides: this only chooses what to ask for.
 */
export function chooseInvitationSeats(input: {
  addresses: readonly string[];
  wants(email: string): boolean;
  seats: readonly OrganizationSeat[];
  kept: Readonly<Record<string, string>>;
}): InvitationSeatChoice {
  const free = input.seats.filter(usable).toSorted(fullestFirst);
  const wanted = input.addresses.filter(input.wants);
  const taken = new Set<string>();
  const seats: Record<string, string> = {};
  for (const email of wanted) {
    const kept = input.kept[email];
    if (kept === undefined || taken.has(kept) || !free.some((seat) => seat.id === kept)) continue;
    seats[email] = kept;
    taken.add(kept);
  }
  for (const email of wanted) {
    if (seats[email] !== undefined) continue;
    const next = free.find((seat) => !taken.has(seat.id));
    if (!next) break;
    seats[email] = next.id;
    taken.add(next.id);
  }
  return { seats, free: free.length };
}

export const freeSeatsWords = (used: number, free: number): string => (free === 0 ? "0 free seats" : `${used} of ${free} free seats`);
