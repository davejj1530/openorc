import { useEffect, useRef, useState, type FocusEvent } from "react";

/** How long the pointer must be off the list before what waited lands, so a pass across its edge moves nothing. */
const SETTLE_MS = 1500;

/**
 * Whether the list holds still: while the pointer is over it, a moment after the pointer leaves, and while the keyboard
 * is in it. Focus that a click left on a row does not hold it. Spread `props` on the list.
 */
export function useListHold() {
  const [pointer, setPointer] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return {
    held: pointer || keyboard,
    props: {
      onPointerEnter: () => {
        window.clearTimeout(timer.current);
        setPointer(true);
      },
      onPointerLeave: () => {
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setPointer(false), SETTLE_MS);
      },
      onFocus: (event: FocusEvent<HTMLElement>) => setKeyboard(event.target.matches(":focus-visible")),
      onBlur: (event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setKeyboard(false);
      },
    },
  };
}
