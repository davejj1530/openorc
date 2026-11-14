import type { OrganizationSeat } from "@openorc/protocol";

export type AvailableSeatChoice = { state: "ready"; seat: OrganizationSeat } | { state: "unknown" | "empty" };
type MeasuredSeat = OrganizationSeat & { included: NonNullable<OrganizationSeat["included"]>; period: NonNullable<OrganizationSeat["period"]> };

export function chooseAvailableSeat(seats: readonly OrganizationSeat[]): AvailableSeatChoice {
  const available = seats.filter((seat) => seat.assignment.kind === "available" && seat.retiresAt === null);
  const measured = available.filter((seat): seat is MeasuredSeat => seat.included !== null && seat.period !== null);
  if (measured.length !== available.length) return { state: "unknown" };
  const chosen = measured.toSorted((a, b) => b.included.leftSeconds - a.included.leftSeconds || (a.id < b.id ? -1 : Number(a.id > b.id)))[0];
  return chosen ? { state: "ready", seat: chosen } : { state: "empty" };
}
