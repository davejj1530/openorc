/**
 * Timing primitives for the hero scenes. Moments are named instants in
 * seconds; elements appear during windows written against those names.
 * A journey has one timeline per framing: narrow screens pan across the
 * desktop window and need more room between moments for those camera moves.
 */

export type Timeline = Record<string, number>;
export type Layout = "wide" | "narrow";

export interface Journey {
  timelines: Record<Layout, Timeline>;
  /**
   * `data-*` attributes on the scene root: the resting value, and the windows
   * that switch it to another value, per layout.
   */
  states: Record<string, { rest: string; narrow?: Record<string, string>; wide?: Record<string, string> }>;
}

export function moment(name: string, timeline: Timeline): number {
  const value = timeline[name];
  if (value === undefined) throw new Error(`Unknown hero moment: ${name}`);
  return value;
}

/**
 * `a~b` holds from a until b, `>a` from a onward, and `<a` until a.
 * Several windows are separated by spaces.
 */
export function visibleAt(windows: string, timeline: Timeline, t: number): boolean {
  return windows.split(" ").some((window) => {
    if (window.startsWith(">")) return t >= moment(window.slice(1), timeline);
    if (window.startsWith("<")) return t < moment(window.slice(1), timeline);
    const [from, to] = window.split("~");
    return t >= moment(from, timeline) && t < moment(to, timeline);
  });
}

/**
 * Attributes for an element that appears during `windows`. Both layouts share
 * their first and last frames, so the server marks them from the wide timeline:
 * the page opens on the first frame, and on the last one when nothing plays.
 */
export function timed(journey: Journey, windows: string) {
  const { wide } = journey.timelines;
  return {
    "data-show": windows,
    "data-start-hidden": visibleAt(windows, wide, 0) ? undefined : "",
    "data-end-hidden": visibleAt(windows, wide, moment("end", wide)) ? undefined : "",
  };
}

/**
 * Attributes for an element whose `data-<name>` states hold during windows, as `name: windows` pairs. The player
 * toggles them; the server sets the ones that hold at the last moment, which the page shows when nothing plays.
 */
export function flagged(journey: Journey, flags: Record<string, string>) {
  const { wide } = journey.timelines;
  const end = moment("end", wide);
  const attributes: Record<string, string | undefined> = {
    "data-flag": Object.entries(flags)
      .map(([name, windows]) => `${name}:${windows}`)
      .join(";"),
  };
  for (const [name, windows] of Object.entries(flags)) attributes[`data-${name}`] = visibleAt(windows, wide, end) ? "" : undefined;
  return attributes;
}

/** Elapsed work as the app writes it: "42s", then "1m 5s". */
export function duration(seconds: number): string {
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Whole seconds from one moment to another (the end by default) on the wide timeline, which pages without a player show. */
export function elapsed(journey: Journey, from: string, to = "end"): number {
  const { wide } = journey.timelines;
  return Math.max(0, Math.floor(moment(to, wide) - moment(from, wide)));
}
