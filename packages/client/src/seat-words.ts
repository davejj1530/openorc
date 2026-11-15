import type { AllowanceSource, OrganizationAccess, ProLossReason } from "@openorc/protocol";
import { accountDay } from "./account-words.js";

const frozenWords: Record<ProLossReason, string> = {
  no_pro: "You need Pro to use an organization. Open Account or ask an admin for a seat.",
  seat_removed: "Your seat was taken back, and your day of grace has ended.",
  payment_failed: "Payment for your Pro wasn't completed within a day.",
  subscription_ended: "Your Pro subscription ended, and your day of grace has ended.",
};

/** A known deadline closes access even while the authoritative read is out of reach. */
export function organizationAccessAt(access: OrganizationAccess | undefined, now: number): OrganizationAccess | undefined {
  if (access?.state !== "grace" || now < access.until) return access;
  return { state: "frozen", reason: access.reason, until: null, message: frozenWords[access.reason] };
}

export function allowanceSourceWords(source: AllowanceSource | null | undefined): string | null {
  if (!source) return null;
  return source.kind === "self" ? "Paid by you" : `Paid by ${source.organizationName}`;
}

export function seatDeadline(at: number, locale?: string, timeZone?: string): string {
  const time = new Date(at).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit", timeZone });
  return `${accountDay(at, locale, timeZone)}, ${time}`;
}

/**
 * The day of grace's deadline in two lengths: "today" or "tomorrow" with the time where there is room, the weekday
 * with the time where there is not. A deadline further off names its date in both, where a weekday alone could
 * mislead. Calendar days are compared in the display timezone, including across daylight-saving changes.
 */
export function graceDeadlineWords(until: number, now: number, locale?: string, timeZone?: string): { long: string; short: string } {
  const days = localDay(until, timeZone) - localDay(now, timeZone);
  if (days !== 0 && days !== 86400000) {
    const dated = `Pro ends ${seatDeadline(until, locale, timeZone)}`;
    return { long: dated, short: dated };
  }
  const time = new Date(until).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit", timeZone });
  const weekday = new Date(until).toLocaleDateString(locale, { weekday: "short", timeZone });
  return { long: `Pro ends ${days === 0 ? "today" : "tomorrow"} at ${time}`, short: `Pro ends ${weekday} ${time}` };
}

function localDay(at: number, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat("en", { year: "numeric", month: "numeric", day: "numeric", timeZone }).formatToParts(at);
  const number = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(number("year"), number("month") - 1, number("day"));
}
