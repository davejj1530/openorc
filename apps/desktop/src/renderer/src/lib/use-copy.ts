import { useEffect, useState } from "react";

export type CopyState = "idle" | "copied" | "error";

/** Copies text to the clipboard, and holds how that went for a moment so the control can say so. */
export function useCopy(text: string): [state: CopyState, copy: () => void] {
  const [state, setState] = useState<CopyState>("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [state]);
  const copy = () => {
    void navigator.clipboard.writeText(text).then(
      () => setState("copied"),
      () => setState("error"),
    );
  };
  return [state, copy];
}
