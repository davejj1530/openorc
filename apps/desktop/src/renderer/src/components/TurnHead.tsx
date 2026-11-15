import { useRef } from "react";
import { harnessShortName, isHarnessId } from "@openorc/protocol";
import { cn } from "../lib/cn";
import { useRunVoice, useTurnAuthor } from "../lib/turn-authors";
import { turnStatusWords, type TurnStatus } from "@openorc/client";
import { HarnessLogo } from "./HarnessLogo";
import { useTurnSender } from "../lib/thread-authors";
import { TurnSender } from "./ThreadVoice";

/**
 * One head per turn: the agent's mark and name, then its model and a status that swaps in place as the turn moves
 * from working to writing to done, then, in a cloud thread others are in, who sent the turn. A turn loaded from history
 * mounts in its final state and does not animate. `blocks`: the turn's, which name its sender.
 */
export function TurnHead({ runId, named, status, blocks }: { runId: string; named?: string | undefined; status: TurnStatus; blocks?: readonly { id: string }[] }) {
  const author = useTurnAuthor(named, runId);
  const sender = useTurnSender(blocks, status.kind === "working" || status.kind === "writing");
  const voice = useRunVoice(runId);
  const first = useRef(status.kind);
  const name = author ?? (voice ? harnessShortName(voice.agent) : "Assistant");
  const words = [voice?.model, turnStatusWords(status)].filter(Boolean).join(" · ");
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
      {sender !== undefined ? <TurnSender person={sender} /> : null}
    </div>
  );
}
