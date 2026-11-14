import type { AccountStatus, CloudHours, Price, ProPeriod } from "@openorc/protocol";

type SignedIn = Extract<AccountStatus, { state: "signed-in" }>;

const HOUR = 3600;

export const accountDay = (at: number, locale?: string, timeZone?: string) => new Date(at).toLocaleDateString(locale, { month: "short", day: "numeric", timeZone });

/** Cloud time as a person reads it: whole hours from an hour up, else minutes, and none as hours, the unit it is counted in. */
export function cloudTime(seconds: number): string {
  const left = Math.max(0, seconds);
  if (left >= HOUR || left < 60) return `${Math.floor(left / HOUR)} h`;
  return `${Math.floor(left / 60)} min`;
}

/** A price as the person's locale writes it, from an amount in the currency's smallest unit; whole amounts without cents. */
export function priceText(price: Price, locale?: string): string {
  const format = new Intl.NumberFormat(locale, { style: "currency", currency: price.currency.toUpperCase(), trailingZeroDisplay: "stripIfInteger" });
  return format.format(price.amount / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2));
}

const PER: Record<ProPeriod, { name: string; per: string }> = { monthly: { name: "Monthly", per: "a month" }, yearly: { name: "Yearly", per: "a year" } };

/** A way of paying for Pro: its price and period, or the period's name alone while the price is not known. */
export function periodLabel(period: ProPeriod, price: Price | null, locale?: string): string {
  return price ? `${priceText(price, locale)} ${PER[period].per}` : PER[period].name;
}

/** The plan in one short line, as the sidebar's foot shows it: "Free", or "Pro · 41 h left", which fits its narrowest width. */
export function planLine(account: Pick<SignedIn, "plan" | "hours">): string {
  if (!account.plan.pro) return "Free";
  return account.hours ? `Pro · ${cloudTime(account.hours.leftSeconds)} left` : "Pro";
}

/** When Pro renews, ends, or stops after a failed payment; null for Free. */
export function planDate(plan: SignedIn["plan"]): string | null {
  if (!plan.pro) return null;
  if (plan.standing === "live") return `Renews ${accountDay(plan.at)}`;
  if (plan.standing === "ending") return `Ends ${accountDay(plan.at)}`;
  return `Payment failed. Pro until ${accountDay(plan.at)}.`;
}

/** What the hours left are made of: the month's, when it resets, and what was bought on top. */
export function hoursDetail(hours: CloudHours): string {
  const parts = hours.monthly ? [`${cloudTime(hours.monthly.leftSeconds)} of ${cloudTime(hours.monthly.grantedSeconds)} this month, resets ${accountDay(hours.monthly.resetsAt)}`] : [];
  if (hours.packsLeftSeconds > 0) parts.push(`${cloudTime(hours.packsLeftSeconds)} bought`);
  return parts.join(", ");
}

/** Up to two initials of a name, for a face with no picture. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? `${words[0]![0]}${words.at(-1)![0]}` : (words[0]?.slice(0, 1) ?? "")).toUpperCase();
}
