import { useEffect, useRef, type RefObject } from "react";

/** Whether the component is still mounted, for work that finishes after an await: true from mount until unmount. */
export function useMounted(): RefObject<boolean> {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}
