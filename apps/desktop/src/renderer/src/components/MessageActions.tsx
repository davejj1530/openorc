import { useRef } from "react";
import { Check, Copy, GitFork } from "./icons";
import { IconButton } from "./ui";
import { cn } from "../lib/cn";
import { useCopy, type CopyState } from "../lib/use-copy";
import { relativeTime, turnStatusWords, type TurnStatus } from "@openorc/client";

/** When the message landed. Hidden until hover, the way the chat apps do it. */
export function MessageTime({ at, className }: { at: number | undefined; className?: string }) {
  if (at === undefined) return null;
  return (
    <div className={cn("message-time", className)} data-tip={new Date(at).toLocaleString()}>
      {relativeTime(at)}
    </div>
  );
}

function copyMessageLabel(state: CopyState): string {
  if (state === "copied") return "Message copied";
  if (state === "error") return "Could not copy message";
  return "Copy message";
}

/** Copy widens just enough to say so: a fill and "Copied" in place, then it gives them back. */
export function CopyMessage({ text }: { text: string }) {
  const [state, copy] = useCopy(text);
  const label = copyMessageLabel(state);
  return (
    <button type="button" aria-label={label} data-tip={label} data-state={state} className="copy-action message-action" onClick={copy}>
      <span className="copy-action-glyph motion-swap" aria-hidden="true">
        <Copy size={16} aria-hidden={state === "copied" ? "true" : undefined} />
        <Check size={16} aria-hidden={state === "copied" ? undefined : "true"} />
      </span>
      {state === "idle" ? null : <span className="copy-action-word motion-arrive">{state === "copied" ? "Copied" : "Failed"}</span>}
    </button>
  );
}

/**
 * The end of a turn: where it stands, "Working 12s" while it runs and "Worked for 41s" once done, in one place, then
 * copy the reply, fork the conversation on the latest turn, and when. A failed or stopped turn keeps saying so there.
 * The last visible turn shows the row at rest; older turns show it on hover, all but a failed or stopped turn's words.
 */
export function TurnEnd({ status, text, at, onFork }: { status: TurnStatus; text: string | undefined; at: number | undefined; onFork?: (() => void) | undefined }) {
  const first = useRef(status.kind);
  const live = status.kind === "working" || status.kind === "writing";
  const words = turnStatusWords(status);
  return (
    <div className="group turn-actions" data-state={status.kind}>
      {words ? (
        <span key={status.kind} className={cn("turn-status", status.kind !== first.current && "motion-arrive")} data-tone={status.kind === "failed" ? "bad" : undefined}>
          {words}
        </span>
      ) : null}
      {!live && text ? <CopyMessage text={text} /> : null}
      {!live && onFork ? (
        <IconButton size="md" onClick={() => onFork()} data-tip="Continue this conversation in a new thread" aria-label="Fork thread" className="message-action">
          <GitFork size={16} />
        </IconButton>
      ) : null}
      {live ? null : <MessageTime at={at} />}
    </div>
  );
}
