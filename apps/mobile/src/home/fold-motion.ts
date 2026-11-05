import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "../generated/tokens";
import { arriveAt, leave } from "../ui/motion";
import { useReducedMotion } from "../ui/reduced-motion";
import type { HomeItem } from "./home-items";

/**
 * How one of Home's rows moves while a fold the reader moved settles: `arrive` is the row's place in a fold that opens,
 * for the stagger; `leave` fades it out before its fold closes; `folding` marks the item whose fold closes, so its glyph
 * says so at once.
 */
export interface RowMotion {
  arrive?: number;
  leave?: true;
  folding?: true;
}

/** A fold just moved: a part of the list's key, or a parent thread's id, and which way it went. */
export interface Moving {
  key: string;
  open: boolean;
}

/** A row no fold is moving. */
export const STILL: RowMotion = {};
const NONE: ReadonlyMap<string, RowMotion> = new Map();
/** Long enough for the last staggered row to finish arriving. */
const SETTLE_MS = 70 + motion.stagger * 8 + motion.duration.arrive + 100;
/** A closing fold commits once its rows have all but faded, so the list's own latency overlaps the end of the fade. */
const FOLD_AFTER_MS = motion.duration.leave - 40;

/** Whether `item` is held by the fold at `holder`: a part of the list holds its rows and paging, a parent its tree. */
function holds(holder: HomeItem, item: HomeItem): boolean {
  if (holder.kind === "section") return item.kind === "thread" || item.kind === "children-more" || item.kind === "more";
  if (holder.kind !== "thread") return false;
  const depth = holder.tree.depth;
  if (item.kind === "thread") return item.tree.depth > depth;
  return item.kind === "children-more" && (item.tree.depth > depth || item.tree.thread.id === holder.thread.id);
}

const foldKey = (item: HomeItem) => (item.kind === "thread" ? item.thread.id : item.key);

/** Each item's motion while `moving` settles; items it does not touch are absent. */
export function foldMotions(items: readonly HomeItem[], moving: Moving | null): ReadonlyMap<string, RowMotion> {
  if (!moving) return NONE;
  const motions = new Map<string, RowMotion>();
  const at = items.findIndex((item) => item.kind !== "more" && item.kind !== "retry" && foldKey(item) === moving.key);
  if (at === -1) return motions;
  const holder = items[at]!;
  if (!moving.open) motions.set(holder.key, { folding: true });
  for (let index = at + 1; index < items.length && holds(holder, items[index]!); index++) motions.set(items[index]!.key, moving.open ? { arrive: index - at - 1 } : { leave: true });
  return motions;
}

export const rowMotion = (motions: ReadonlyMap<string, RowMotion>, key: string): RowMotion => motions.get(key) ?? STILL;

/** The animation a row's motion plays; none under reduced motion. */
export function movingStyle(motion: RowMotion, still: boolean) {
  if (still) return undefined;
  if (motion.leave) return leave;
  return motion.arrive === undefined ? undefined : arriveAt(motion.arrive);
}

/**
 * Folds with motion, as the motion map has them: opening commits at once and its rows rise in one after another while
 * the rows under them slide (the list's layout transition); closing fades its rows first and folds after them. A newer
 * toggle overtakes: closing the same fold again before it folded keeps it open, another fold commits the pending one.
 * Under reduced motion every fold commits at once.
 */
export function useFoldMotion(items: readonly HomeItem[], commit: (key: string, open: boolean) => void) {
  const still = useReducedMotion();
  const [moving, setMoving] = useState<Moving | null>(null);
  const pending = useRef<{ moving: Moving; timer: ReturnType<typeof setTimeout> } | null>(null);
  const latest = useRef(commit);
  latest.current = commit;
  useEffect(() => () => clearTimeout(pending.current?.timer), []);
  const toggle = useCallback(
    (key: string, open: boolean) => {
      const before = pending.current;
      if (before) {
        clearTimeout(before.timer);
        pending.current = null;
        if (!before.moving.open) {
          if (before.moving.key === key) return setMoving(null);
          latest.current(before.moving.key, false);
        }
      }
      if (still) return latest.current(key, open);
      const next = { key, open };
      if (open) latest.current(key, true);
      setMoving(next);
      pending.current = {
        moving: next,
        timer: setTimeout(
          () => {
            pending.current = null;
            if (!open) latest.current(key, false);
            setMoving(null);
          },
          open ? SETTLE_MS : FOLD_AFTER_MS,
        ),
      };
    },
    [still],
  );
  return { motions: foldMotions(items, moving), toggle };
}
