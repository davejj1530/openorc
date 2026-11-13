import type { SendCluster, SendWay } from "@openorc/client";
import { useState } from "react";
import { ArrowUp } from "./icons";

const WAY_WORDS: Record<SendWay, string> = { now: "Send now", queue: "Queue" };
const START_WORDS = "Start from the task";

/** The words the ink button carries, if any: what Enter does mid-turn, or that an empty send starts the task. */
function inkWords(cluster: SendCluster): string | null {
  if (cluster.kind === "turn") return WAY_WORDS[cluster.enter];
  if (cluster.kind === "send" && cluster.startsTask) return START_WORDS;
  return null;
}

/** The last words the button carried, kept while they fold away, so the pill narrows with its words still in it. */
function useFoldingWords(words: string | null): string {
  const [last, setLast] = useState(words ?? "");
  if (words && words !== last) setLast(words);
  return words ?? last;
}

/** What the ink button names when it shows no words: its glyph's meaning, or why it cannot be pressed. */
function inkTip(stops: boolean, words: string | null, reason: string | undefined): string | undefined {
  if (stops) return "Stop";
  if (words) return reason;
  return reason ?? "Send";
}

/**
 * The send cluster at the composer bar's end. The ink button is one button through every state: the bare arrow with
 * nothing running, the one Stop with nothing typed while something runs, and a pill carrying the word of what Enter
 * does mid-turn, so a turn starting or ending swaps it in place. Mid-turn, Stop steps aside as a white key and the other
 * way waits beside the pill as a quiet word, dimmed with its reason when the turn cannot take it.
 */
export function ComposerSendCluster({
  cluster,
  canSend,
  block,
  stopping,
  onSend,
  onStop,
}: {
  cluster: SendCluster;
  canSend: boolean;
  /** Why nothing can be sent, said on demand by the dimmed send. */
  block: string | null;
  stopping: boolean;
  /** `other` is the quiet word's way rather than Enter's. */
  onSend: (other: boolean) => void;
  onStop: () => void;
}) {
  const reason = canSend ? undefined : (block ?? undefined);
  return (
    <div className="composer-send-cluster">
      {cluster.kind !== "stop" && cluster.stop ? <StopKey stopping={stopping} onStop={onStop} /> : null}
      {cluster.kind === "turn" ? (
        <button type="button" onClick={() => onSend(true)} disabled={!canSend || Boolean(cluster.other.blocked)} data-tip={cluster.other.blocked ?? reason} className="composer-send-other">
          {WAY_WORDS[cluster.other.way]}
        </button>
      ) : null}
      <InkButton cluster={cluster} canSend={canSend} reason={reason} stopping={stopping} onSend={() => onSend(false)} onStop={onStop} />
    </div>
  );
}

function StopKey({ stopping, onStop }: { stopping: boolean; onStop: () => void }) {
  return (
    <button type="button" onClick={onStop} disabled={stopping} aria-label="Stop" data-tip="Stop" className="composer-stop">
      <span className="composer-stop-glyph" />
    </button>
  );
}

function InkButton({
  cluster,
  canSend,
  reason,
  stopping,
  onSend,
  onStop,
}: {
  cluster: SendCluster;
  canSend: boolean;
  reason: string | undefined;
  stopping: boolean;
  onSend: () => void;
  onStop: () => void;
}) {
  const words = inkWords(cluster);
  const folding = useFoldingWords(words);
  const stops = cluster.kind === "stop";
  return (
    <button
      type="button"
      onClick={stops ? onStop : onSend}
      disabled={stops ? stopping : !canSend}
      aria-label={stops ? "Stop" : (words ?? "Send")}
      data-tip={inkTip(stops, words, reason)}
      data-state={stops ? "stop" : "send"}
      data-words={words ? true : undefined}
      className="composer-send"
    >
      <span className="composer-send-words" aria-hidden="true">
        <span>{folding}</span>
      </span>
      <span className="composer-send-glyph" aria-hidden="true">
        <span className="composer-send-layer" data-layer="send">
          <ArrowUp size={16} />
        </span>
        <span className="composer-send-layer" data-layer="stop">
          <span className="composer-stop-glyph" />
        </span>
      </span>
    </button>
  );
}
