/**
 * The sample project's year under the new thread composer (ProjectActivity.tsx): one shade a day, a week to a column,
 * the last week running to today. Seeded, so every build draws the same year: about seven months of work, busy
 * weekdays, quiet weekends, a few days off.
 */

const WEEKS = 53;
const TODAY_IN_WEEK = 4;
const DAYS = (WEEKS - 1) * 7 + TODAY_IN_WEEK + 1;
const ACTIVE_DAYS = 210;
const TODAY = Date.UTC(2026, 10, 9);

let seed = 7;
const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

const start = DAYS - ACTIVE_DAYS;
const turns = Array.from({ length: DAYS }, (_, index) => {
  const weekend = index % 7 >= 5;
  if (index < start || random() < (weekend ? 0.6 : 0.12)) return 0;
  return Math.round((weekend ? 4 : 10) + random() * (weekend ? 8 : 34) * Math.min(1, (index - start) / 90 + 0.4));
});
const steps = turns.reduce((sum, count) => sum + count * (18 + Math.round(random() * 14)), 0);

/** 0 for a day without turns, else 1 to 4 by the day's rank among active days, as activityLevels ranks them. */
const active = turns.filter((count) => count > 0).sort((a, b) => a - b);
const level = (count: number) => (count === 0 ? 0 : 1 + Math.round((3 * (active.indexOf(count) + active.lastIndexOf(count))) / 2 / (active.length - 1)));

const first = turns.findIndex((count) => count > 0);
const since = new Date(TODAY - (DAYS - 1 - first) * 86_400_000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const count = (value: number) => value.toLocaleString("en-US");

export const activity = {
  weeks: WEEKS,
  levels: turns.map(level),
  summary: `${count(turns.reduce((sum, value) => sum + value, 0))} turns and ${count(steps)} steps since ${since}`,
};
