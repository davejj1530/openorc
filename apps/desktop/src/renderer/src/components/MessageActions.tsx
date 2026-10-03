import { useEffect, useState } from "react";
import { Check, Copy } from "./icons";
import { IconButton } from "./ui";
import { cn } from "../lib/cn";
import { relativeTime } from "../lib/time";

/** When the message landed. Hidden until hover, the way the chat apps do it. */
export function MessageTime({ at, className }: { at: number | undefined; className?: string }) {
  if (at === undefined) return null;
  return (
    <div
      className={cn("h-5 flex items-center text-xs text-ink-4 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity", className)}
      title={new Date(at).toLocaleString()}
    >
      {relativeTime(at)}
    </div>
  );
}

function copyMessageLabel(state: "idle" | "copied" | "error"): string {
  if (state === "copied") return "Message copied";
  if (state === "error") return "Could not copy message";
  return "Copy message";
}

export function CopyMessage({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [state]);
  const label = copyMessageLabel(state);
  return (
    <IconButton
      size="sm"
      aria-label={label}
      title={label}
      className={cn(
        "transition-opacity opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
        state !== "idle" && "opacity-100",
      )}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => setState("copied"),
          () => setState("error"),
        );
      }}
    >
      {state === "copied" ? <Check size={13} /> : <Copy size={13} />}
    </IconButton>
  );
}
