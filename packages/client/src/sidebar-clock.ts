import { useEffect, useState } from "react";

/** How often the list looks at the clock again with nothing new to show. */
const SIDEBAR_TICK_MS = 60_000;

/**
 * The time the list groups its threads by. It renders the list again each minute, so a thread leaves Recent and a day
 * turns over while no new work arrives.
 */
export function useSidebarNow(): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((tick) => tick + 1), SIDEBAR_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return Date.now();
}
