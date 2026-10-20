import { useRef } from "react";
import { harnessShortName, isHarnessId } from "@openorc/protocol";
import { cn } from "../lib/cn";
import { useRunVoice, useTurnAuthor } from "../lib/turn-authors";
import { workDuration } from "../lib/work-transcript";
import { HarnessLogo } from "./HarnessLogo";

/** Where a turn stands, as its head says it: working with its clock, writing the reply, or done, failed or stopped. */
export type TurnStatus = { kind: "working" | "writing" | "done" | "failed" | "stopped"; elapsed?: number | undefined };

function statusWords({ kind, elapsed }: TurnStatus): string {
  const time = elapsed === undefined ? "" : workDuration(elapsed);
  if (kind === "working") return time ? `working ${time}` : "working";
  if (kind === "writing") return "Writing";
  if (kind === "failed") return time ? `Failed after ${time}` : "Failed";
  if (kind === "stopped") return time ? `Stopped after ${time}` : "Stopped";
  return time;
}

/**
 * One head per turn: the agent's mark and name, then its model and a status that swaps in place as the turn moves
 * from working to writing to done. A turn loaded from history mounts in its final state and does not animate.
 */
export function TurnHead({ runId, named, status }: { runId: string; named?: string | undefined; status: TurnStatus }) {
  const author = useTurnAuthor(named, runId);
  const voice = useRunVoice(runId);
  const first = useRef(status.kind);
  const name = author ?? (voice ? harnessShortName(voice.agent) : "Assistant");
  const words = [voice?.model, statusWords(status)].filter(Boolean).join(" · ");
  return (
    <div className="turn-head" data-state={status.kind}>
      {voice && isHarnessId(voice.agent) ? <HarnessLogo id={voice.agent} size={14} className="turn-head-mark" /> : null}
      <span className="turn-head-name">{name}</span>
      {words ? (
        <span className="turn-head-status">
          <span key={status.kind} className={cn("turn-head-words", status.kind !== first.current && "motion-arrive")} data-tone={status.kind === "failed" ? "bad" : undefined}>
            {words}
          </span>
        </span>
      ) : null}
    </div>
  );
}
