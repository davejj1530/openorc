import type { ProjectActivityDay, RpcParams } from "@openorc/protocol";

/** A year of weeks, the most the new thread screen draws. Narrow panes draw the latest that fit. */
export const ACTIVITY_WEEKS = 53;

/** The weekday a week starts on in the viewer's locale, 0 for Sunday; Sunday where the runtime cannot say. */
export function firstWeekday(locale = typeof navigator === "undefined" ? "en-US" : navigator.language): number {
  try {
    const info = new Intl.Locale(locale) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    return ((info.getWeekInfo?.() ?? info.weekInfo)?.firstDay ?? 7) % 7;
  } catch {
    return 0;
  }
}

/**
 * Midnights in the viewer's calendar from the start of the week a year back through tomorrow, so each day is
 * one of theirs and today is the last. Stable through the day, so a read made ahead of a screen is the one it uses.
 */
export function activityBoundaries(now: number, weekStart = firstWeekday(), weeks = ACTIVITY_WEEKS): number[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const sinceWeekStart = (today.getDay() - weekStart + 7) % 7;
  const first = new Date(today);
  first.setDate(today.getDate() - sinceWeekStart - (weeks - 1) * 7);
  const count = (weeks - 1) * 7 + sinceWeekStart + 1;
  return Array.from({ length: count + 1 }, (_, index) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + index).getTime());
}

export function activityParams(projectId: string, now = Date.now()): RpcParams<"projects.activity"> {
  return { id: projectId, boundaries: activityBoundaries(now) };
}

/**
 * Each day's shade, 0 for none and 1 to 4 by its rank among the active days, so a quiet project and a busy one
 * both use the whole range and one heavy day does not wash the rest out. Days with the same count share their
 * middle rank, so the busiest day alone is darkest and a year of equal days sits mid-range.
 */
export function activityLevels(turns: number[]): number[] {
  const active = turns.filter((count) => count > 0).sort((a, b) => a - b);
  const level = (count: number) => {
    if (count === 0) return 0;
    if (active.length === 1) return 4;
    const rank = (active.indexOf(count) + active.lastIndexOf(count)) / 2;
    return 1 + Math.round((3 * rank) / (active.length - 1));
  };
  return turns.map(level);
}

const counts = new Intl.NumberFormat();
export const formatCount = (value: number) => counts.format(value);
const plural = (count: number, one: string, many: string) => `${formatCount(count)} ${count === 1 ? one : many}`;

const work = (turns: number, steps: number) => [plural(turns, "turn", "turns"), ...(steps > 0 ? [plural(steps, "step", "steps")] : [])].join(" and ");

/** A date in the viewer's words, with the year once it is not this one. */
function date(start: number, now: number, weekday: boolean): string {
  const sameYear = new Date(start).getFullYear() === new Date(now).getFullYear();
  return new Date(start).toLocaleDateString(undefined, { ...(weekday ? { weekday: "short" as const } : {}), month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" as const }) });
}

/**
 * "837 turns and 23,591 steps since Sep 29", from the first active day the pane shows. Activity that reaches back to
 * the oldest week shown may have started before it, so that reads "in the last year" (or weeks, in a narrow pane).
 */
export function activitySummary({ turns, steps, since, weeks, now }: { turns: number; steps: number; since: number | null; weeks: number; now: number }): string {
  const period = since === null ? `in the last ${weeks >= 52 ? "year" : `${weeks} weeks`}` : `since ${date(since, now, false)}`;
  return `${work(turns, steps)} ${period}`;
}

/** "23 turns and 412 steps in 6 threads" for one day. */
export function dayDetail(day: ProjectActivityDay): string {
  if (day.turns === 0 && day.steps === 0) return "No turns";
  return day.threads > 0 ? `${work(day.turns, day.steps)} in ${plural(day.threads, "thread", "threads")}` : work(day.turns, day.steps);
}

/** "Tue, Nov 4", with the year once it is not this one. */
export function dayLabel(start: number, now: number): string {
  return date(start, now, true);
}
