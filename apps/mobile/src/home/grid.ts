/**
 * Home's one column grid, in points from the screen's leading edge. Every row draws on it: the lead column holds the
 * wordmark's cube, the Mac line's dot, heading glyphs, status marks and tree nodes, centered on `LEAD_CENTER`; names,
 * titles and second lines start at `TEXT_X`; the trailing action column holds the header's circles, the headings'
 * pluses and the rows' disclosures, centered `ACTION_INSET` from the trailing edge. A sub thread steps in by `STEP`, so
 * its mark sits under its parent's title. Classes spell the same numbers: px-5 the margin, w-7 the lead, gap-3 the gap.
 */
export const MARGIN = 20;
const LEAD = 28;
const GAP = 12;
export const STEP = LEAD + GAP;
export const LEAD_CENTER = MARGIN + LEAD / 2;
export const TEXT_X = MARGIN + STEP;
/** The center of a root row's 16 pt project glyph at the margin, where the row's tree line leaves for its sub threads. */
export const ROOT_NODE = MARGIN + 8;
/** From the trailing edge to the action column's center: a 40 pt header circle ends at the margin. */
export const ACTION_INSET = MARGIN + 20;
/** The 44 pt touch around an action, from the trailing edge. */
export const ACTION_RIGHT = ACTION_INSET - 22;
/** A row's pressed fill runs this far outside the margin (mx-3), so the fill has room around the mark. */
export const ROW_INSET = 12;
/**
 * What every row keeps clear at its trailing end: the action column. Titles, second lines and a sub thread's fact end
 * where the headings' counts end, at the action's touch; the column holds a disclosure or nothing.
 */
export const ACTION_RESERVE = ACTION_RIGHT + 44 - ROW_INSET;
/** How far interface text grows with the reader's text size (ui/Text.tsx). */
const CHROME_SCALE = 1.4;

/**
 * Where a row's title line is centered, from the row's top, at the reader's text size: a root row's 8 pt padding and
 * half its title's 24 pt line; a compact row is centered on its 44 pt height until its 22 pt line outgrows it.
 */
export function titleMid(compact: boolean, fontScale: number): number {
  const scale = Math.min(fontScale, CHROME_SCALE);
  return compact ? Math.max(22, 11 + 11 * scale) : 8 + 12 * scale;
}
/** How many levels a sub thread steps in; deeper ones stay at the last. */
export const MAX_DEPTH = 3;
