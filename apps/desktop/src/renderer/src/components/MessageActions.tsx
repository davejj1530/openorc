import { useEffect, useState } from "react";
import { Check, Copy, GitFork } from "./icons";
import { IconButton } from "./ui";
import { cn } from "../lib/cn";
import { relativeTime } from "../lib/time";

/** When the message landed. Hidden until hover, the way the chat apps do it. */
export function MessageTime({ at, className }: { at: number | undefined; className?: string }) {
  if (at === undefined) return null;
  return (
    <div className={cn("message-time", className)} title={new Date(at).toLocaleString()}>
      {relativeTime(at)}
    </div>
  );
}

function copyMessageLabel(state: "idle" | "copied" | "error"): string {
  if (state === "copied") return "Message copied";
  if (state === "error") return "Could not copy message";
  return "Copy message";
}

/** Copy widens just enough to say so: a fill and "Copied" in place, then it gives them back. */
export function CopyMessage({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [state]);
  const label = copyMessageLabel(state);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-state={state}
      className="copy-action message-action"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => setState("copied"),
          () => setState("error"),
        );
      }}
    >
      <span className="copy-action-glyph motion-swap" aria-hidden="true">
        <Copy size={16} aria-hidden={state === "copied" ? "true" : undefined} />
        <Check size={16} aria-hidden={state === "copied" ? undefined : "true"} />
      </span>
      {state === "idle" ? null : <span className="copy-action-word motion-arrive">{state === "copied" ? "Copied" : "Failed"}</span>}
    </button>
  );
}

/**
 * The end of a turn: copy the reply and, on the latest turn, fork the conversation from it. The latest turn shows
 * the row at rest; older turns show it on hover. The time stays a hover detail.
 */
export function TurnActions({ text, at, onFork, resting }: { text: string | undefined; at: number | undefined; onFork?: (() => void) | undefined; resting: boolean }) {
  return (
    <div className="group turn-actions" data-resting={resting || undefined}>
      {text ? <CopyMessage text={text} /> : null}
      {onFork ? (
        <IconButton size="md" onClick={() => onFork()} title="Continue this conversation in a new thread" aria-label="Fork thread" className="message-action">
          <GitFork size={16} />
        </IconButton>
      ) : null}
      <MessageTime at={at} />
    </div>
  );
}
