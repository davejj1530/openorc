import type { ThreadTreeRow } from "@openorc/client";
import { LEAD_CENTER, MAX_DEPTH, STEP, TEXT_X } from "./grid";

/** The space every line leaves before what it meets: a status glyph's edge, or a title. */
export const LINE_GAP = 3;
/** The radius of an elbow's turn. */
const TURN = 6;
/** How far a trunk runs past its row's top and foot, into the next row's, so stacked rows join without a seam. */
export const SEAM = 1;

/** The center of the lead column `level` steps in. */
const lane = (level: number) => LEAD_CENTER + Math.min(level, MAX_DEPTH) * STEP;

/**
 * Where a line meets a row on its title line: `LINE_GAP` short of its status glyph, which reaches `reach` left of the
 * lead column's center, or of its title when it shows no status.
 */
const meets = (depth: number, reach: number | null) => (reach === null ? TEXT_X + Math.min(depth, MAX_DEPTH) * STEP : lane(depth) - reach) - LINE_GAP;

/**
 * One row's share of its project's tree as one SVG path, in points from the row's top left. Ancestors' trunks pass
 * through; an elbow turns in from the parent's trunk on the title line (`mid`); a parent's own trunk drops from
 * `LINE_GAP` under its glyph, or turns down out of the space before its title when it has none, and runs to the row's
 * foot, where its children's rows carry it on to the last child's elbow. At the indentation cap deeper rows share the
 * last lane, so a capped parent's trunk turns back into its own spine.
 */
export function branchPath(row: ThreadTreeRow, { mid, height, reach }: { mid: number; height: number; reach: number | null }): string {
  const depth = Math.min(row.depth, MAX_DEPTH);
  const own = lane(depth);
  const spine = lane(depth - 1);
  const foot = height + SEAM;
  const paths = trunks(row.continuing, foot);
  if (depth) {
    paths.push(`M${spine} ${-SEAM}V${mid - TURN}q0 ${TURN} ${TURN} ${TURN}H${meets(row.depth, reach)}`);
    if (!row.last) paths.push(`M${spine} ${mid - TURN}V${foot}`);
  }
  if (row.hasChildren && row.expanded && row.visibleChildren !== 0) {
    const capped = row.depth >= MAX_DEPTH;
    const trunk = capped ? spine : own;
    if (reach !== null && !capped) paths.push(`M${own} ${mid + reach + LINE_GAP}V${foot}`);
    else paths.push(`M${meets(row.depth, reach)} ${mid}H${trunk + TURN}q${-TURN} 0 ${-TURN} ${TURN}V${foot}`);
  }
  return paths.join(" ");
}

const trunks = (levels: readonly number[], foot: number) => [...new Set(levels.map((level) => lane(level - 1)))].map((x) => `M${x} ${-SEAM}V${foot}`);

/** A paging row's share: only the trunks that run on past it, its parent's own when the parent has siblings after it. */
export function pagePath(row: ThreadTreeRow, height: number): string {
  return trunks(row.depth && !row.last ? [...row.continuing, row.depth] : row.continuing, height + SEAM).join(" ");
}
