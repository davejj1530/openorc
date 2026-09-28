import { useEffect, useRef, useState } from "react";
import { observeOnScreen } from "../lib/motion";

/** The maximum-effort starfield only runs while its picker is visible. */
export function EffortGalaxy() {
  const ref = useRef<HTMLSpanElement>(null);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return observeOnScreen(element, setRunning);
  }, []);
  return (
    <span ref={ref} className="effort-galaxy" data-running={running} aria-hidden="true">
      <span className="effort-galaxy-clouds" />
      <span className="effort-galaxy-stars effort-galaxy-stars-far" />
      <span className="effort-galaxy-stars effort-galaxy-stars-near" />
    </span>
  );
}
