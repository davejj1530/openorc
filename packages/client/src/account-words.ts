import type { AccountStatus, CloudHours } from "@openorc/protocol";

type SignedIn = Extract<AccountStatus, { state: "signed-in" }>;

const HOUR = 3600;

const day = (at: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** Cloud time as a person reads it: whole hours from an hour up, else minutes. */
export function cloudTime(seconds: number): string {
  const left = Math.max(0, seconds);
  return left >= HOUR ? `${Math.floor(left / HOUR)} h` : `${Math.floor(left / 60)} min`;
}

/** The plan in one short line, as the sidebar's foot shows it: "Free", or "Pro · 41 h left", which fits its narrowest width. */
export function planLine(account: Pick<SignedIn, "plan" | "hours">): string {
  if (!account.plan.pro) return "Free";
  return account.hours ? `Pro · ${cloudTime(account.hours.leftSeconds)} left` : "Pro";
}

/** When Pro renews, ends, or stops after a failed payment; null for Free. */
export function planDate(plan: SignedIn["plan"]): string | null {
  if (!plan.pro) return null;
  if (plan.standing === "live") return `Renews ${day(plan.at)}`;
  if (plan.standing === "ending") return `Ends ${day(plan.at)}`;
  return `Payment failed. Pro until ${day(plan.at)}.`;
}

/** What the hours left are made of: the month's, when it resets, and what was bought on top. */
export function hoursDetail(hours: CloudHours): string {
  const parts = hours.monthly ? [`${cloudTime(hours.monthly.leftSeconds)} of ${cloudTime(hours.monthly.grantedSeconds)} this month, resets ${day(hours.monthly.resetsAt)}`] : [];
  if (hours.packsLeftSeconds > 0) parts.push(`${cloudTime(hours.packsLeftSeconds)} bought`);
  return parts.join(", ");
}

/** Up to two initials of a name, for a face with no picture. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? `${words[0]![0]}${words.at(-1)![0]}` : (words[0]?.slice(0, 1) ?? "")).toUpperCase();
}
