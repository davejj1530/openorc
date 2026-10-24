import { useEffect, useState } from "react";
import { haptic } from "../ui/haptics";

/** Why the dim pill is dim, once the person taps it to ask, until the reason goes away. */
export function useDimReason(reason: string | null) {
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (!reason) setAsked(false);
  }, [reason]);
  return {
    shown: asked ? reason : null,
    ask: () => {
      if (!reason) return;
      haptic.warn();
      setAsked(true);
    },
  };
}
