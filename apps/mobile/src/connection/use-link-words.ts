import { useEffect, useState } from "react";
import { linkWords, type LinkWords } from "./link-words";
import type { LinkState } from "./manager";

/** How long a first connect may take before a screen says so; a quick one only changes the dot. */
export const QUIET_CONNECT_MS = 1_500;

/**
 * The connection's words, holding back the status while a connect that had no trouble before it is still quick, so
 * words do not flash in beside the Mac's name. The dot changes at once.
 */
export function useLinkWords(state: LinkState): LinkWords {
  const quick = state.kind === "connecting" && state.why === null;
  const [late, setLate] = useState(false);
  useEffect(() => {
    setLate(false);
    if (!quick) return;
    const timer = setTimeout(() => setLate(true), QUIET_CONNECT_MS);
    return () => clearTimeout(timer);
  }, [quick]);
  const words = linkWords(state);
  return quick && !late ? { ...words, status: null } : words;
}
