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
