import { useEffect, useState } from "react";
import { linkWords, type LinkWords } from "./link-words";
import type { LinkState } from "./manager";

/** How long a first connect may take before a screen says so; a quick one only changes the dot. */
export const QUIET_CONNECT_MS = 1_500;

/**
 * The connection's words, held back while a connect that had no trouble before it is still quick, so a line does not
 * flash in and move what is under the person's finger. `quiet` is true meanwhile.
 */
export function useLinkWords(state: LinkState): LinkWords & { quiet: boolean } {
  const quick = state.kind === "connecting" && state.why === null;
  const [late, setLate] = useState(false);
  useEffect(() => {
    setLate(false);
    if (!quick) return;
    const timer = setTimeout(() => setLate(true), QUIET_CONNECT_MS);
    return () => clearTimeout(timer);
  }, [quick]);
  return { ...linkWords(state), quiet: quick && !late };
}
