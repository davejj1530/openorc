import { useEffect, useRef, useState } from "react";
import { motion } from "../generated/tokens";
import { arriveAt, leave } from "../ui/motion";
import { useReducedMotion } from "../ui/reduced-motion";

/** Long enough for the last staggered row to finish arriving. */
const SETTLE_MS = 70 + motion.stagger * 8 + motion.duration.arrive + 100;
/** A closing group folds once its rows have all but faded. */
const FOLD_AFTER_MS = motion.duration.leave - 40;

/** One group's fold: whether its rows are drawn, whether it reads as open, and how row `at` moves while it settles. */
export interface TaskFold {
  /** Its rows are drawn: open, or fading before it folds. */
  shown: boolean;
  /** Open as its heading says it, which turns at once on a tap. */
  open: boolean;
  rowStyle: (at: number) => ReturnType<typeof arriveAt> | typeof leave | undefined;
  toggle: () => void;
}

/**
 * The task list's folds, as Home's parts fold: opening shows the rows at once, rising in one after another; closing
 * fades them, then folds. Tapping a closing group again keeps it open; another group's tap folds the pending one first.
 * Under reduced motion every fold is at once.
 */
export function useTaskFolds(): (key: string) => TaskFold {
  const still = useReducedMotion();
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const [moving, setMoving] = useState<{ key: string; open: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const commit = (key: string, open: boolean) =>
    setFolded((before) => {
      const next = new Set(before);
      if (open) next.delete(key);
      else next.add(key);
      return next;
    });
  const toggle = (key: string) => {
    clearTimeout(timer.current);
    if (moving && !moving.open) {
      if (moving.key === key) return setMoving(null);
      commit(moving.key, false);
    }
    const open = folded.has(key);
    if (still) return commit(key, open);
    if (open) commit(key, true);
    setMoving({ key, open });
    timer.current = setTimeout(
      () => {
        if (!open) commit(key, false);
        setMoving(null);
      },
      open ? SETTLE_MS : FOLD_AFTER_MS,
    );
  };
  return (key) => {
    const settling = moving?.key === key ? moving : null;
    return {
      shown: !folded.has(key),
      open: !folded.has(key) && settling?.open !== false,
      rowStyle: (at) => {
        if (!settling) return undefined;
        return settling.open ? arriveAt(at) : leave;
      },
      toggle: () => toggle(key),
    };
  };
}
