/** The narrowest an open thread's tab gets while its name still reads; past it, tabs move into the More menu. */
export const TAB_MIN = 120;
/** The widest the open thread's name gets as the header's heading. */
export const HEADING_MAX = 420;

/** What the header measured: its room, the heading's whole name, and the fixed parts around the tabs. */
export type TabRoom = {
  /** The width the header gives the heading, the tabs and the menu. */
  room: number;
  /** The heading's width with its whole name showing. */
  heading: number;
  /** How many other threads are open. */
  count: number;
  /** One tab's width at its narrowest, with the space after it. */
  tab: number;
  /** The More menu's button, with the space before it. */
  more: number;
  /** The space between the heading and the tabs. */
  gap: number;
};

/**
 * How many of the other open threads show as tabs after the heading. The heading keeps its whole name, up to its widest;
 * the tabs shrink to their narrowest, and those that still do not fit move into the More menu, last first. The heading
 * gives up room only once every other thread is in the menu.
 */
export function tabsShown({ room, heading, count, tab, more, gap }: TabRoom): number {
  if (count === 0) return 0;
  const left = room - Math.min(heading, HEADING_MAX) - gap;
  if (count * tab <= left) return count;
  return Math.max(0, Math.min(count - 1, Math.floor((left - more) / tab)));
}
