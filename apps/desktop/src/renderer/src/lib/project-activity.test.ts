import { afterEach, beforeEach, expect, it } from "vitest";
import { activityBoundaries, activityLevels, activitySummary, dayDetail } from "./project-activity";

let zone: string | undefined;
beforeEach(() => {
  zone = process.env["TZ"];
  // A zone with daylight saving inside the year the calendar covers.
  process.env["TZ"] = "America/New_York";
});
afterEach(() => {
  if (zone === undefined) delete process.env["TZ"];
  else process.env["TZ"] = zone;
});

it("starts a year of weeks back on the week's first day and ends after today, every edge a local midnight", () => {
  const monday = new Date(2026, 10, 9, 15, 30).getTime();
  const sunday = activityBoundaries(monday, 0, 53);
  expect(sunday).toHaveLength(52 * 7 + 2 + 1);
  expect(new Date(sunday[0]!).getDay()).toBe(0);
  expect(new Date(sunday[0]!).toDateString()).toBe(new Date(2025, 10, 9).toDateString());
  expect(new Date(sunday.at(-1)!).toDateString()).toBe(new Date(2026, 10, 10).toDateString());
  expect(sunday.every((edge) => new Date(edge).getHours() === 0 && new Date(edge).getMinutes() === 0)).toBe(true);
  // Daylight saving makes some days 23 or 25 hours long.
  const lengths = new Set(sunday.slice(1).map((edge, index) => (edge - sunday[index]!) / 3_600_000));
  expect(lengths).toEqual(new Set([23, 24, 25]));

  const mondayStart = activityBoundaries(monday, 1, 53);
  expect(new Date(mondayStart[0]!).getDay()).toBe(1);
  expect(mondayStart).toHaveLength(52 * 7 + 1 + 1);
});

it("shades days by rank so the busiest is darkest and equal days match, whatever the scale", () => {
  expect(activityLevels([0, 1, 1, 1, 50])).toEqual([0, 2, 2, 2, 4]);
  expect(activityLevels([3, 0, 8, 1, 6, 2, 7, 4, 5])).toEqual([2, 0, 4, 1, 3, 1, 4, 2, 3]);
  expect(activityLevels([2, 5])).toEqual([1, 4]);
  expect(activityLevels([0, 7])).toEqual([0, 4]);
  expect(activityLevels([5, 5, 5])).toEqual([3, 3, 3]);
  expect(activityLevels([0, 0])).toEqual([0, 0]);
});

it("words the year from its first active day, and a day with its steps", () => {
  const now = new Date(2026, 10, 9).getTime();
  expect(activitySummary({ turns: 837, steps: 23591, since: new Date(2026, 8, 29).getTime(), weeks: 53, now })).toBe("837 turns and 23,591 steps since Sep 29");
  expect(activitySummary({ turns: 2537, steps: 1, since: null, weeks: 53, now })).toBe("2,537 turns and 1 step in the last year");
  expect(activitySummary({ turns: 1, steps: 0, since: null, weeks: 30, now })).toBe("1 turn in the last 30 weeks");
  expect(activitySummary({ turns: 4, steps: 9, since: new Date(2025, 11, 30).getTime(), weeks: 53, now })).toBe("4 turns and 9 steps since Dec 30, 2025");
  expect(dayDetail({ turns: 1, steps: 12, threads: 1, agents: [] })).toBe("1 turn and 12 steps in 1 thread");
  expect(dayDetail({ turns: 0, steps: 3, threads: 0, agents: [] })).toBe("0 turns and 3 steps");
  expect(dayDetail({ turns: 0, steps: 0, threads: 0, agents: [] })).toBe("No turns");
});
