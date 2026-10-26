import { useEffect, useState } from "react";

/** Whether `ms` has passed since the caller mounted: a read quicker than that shows no spinner at all. */
export function useLate(ms: number): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(timer);
  }, [ms]);
  return late;
}
