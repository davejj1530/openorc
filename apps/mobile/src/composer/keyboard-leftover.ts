import { useRef } from "react";

/** How soon after a send empties the prompt a change can only be the keyboard's, not the next thing typed. */
export const KEYBOARD_LEFTOVER_MS = 150;

/**
 * A prompt a send empties at once. If iOS had an autocorrection pending for the sent text, it lands it in the emptied
 * prompt in one piece, in the same moment. Nobody types the next message that fast, so a change like that is the
 * keyboard's leftover, and the prompt stays empty.
 */
export function useEmptiedPrompt() {
  const emptiedAt = useRef(Number.NEGATIVE_INFINITY);
  return {
    emptied: () => void (emptiedAt.current = Date.now()),
    leftover: (text: string) => text.length > 1 && Date.now() - emptiedAt.current < KEYBOARD_LEFTOVER_MS,
  };
}
