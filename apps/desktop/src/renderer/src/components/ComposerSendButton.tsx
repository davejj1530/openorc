import type { SendCluster, SendPayer, SendWay } from "@openorc/client";
import { useState } from "react";
import { NOTE_TIP } from "./composer-notes";
import { ArrowUp } from "./icons";

const WAY_WORDS: Record<SendWay, string> = { now: "Send now", queue: "Queue" };
const START_WORDS = "Start from the task";
const NOTE_WORDS = "Post note";

/** The words the ink button carries, if any: what Enter does mid-turn, that an empty send starts the task, or a note. */
function inkWords(cluster: SendCluster): string | null {
  if (cluster.kind === "note") return NOTE_WORDS;
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

/** What the ink button names on demand: why it cannot be pressed, else whose sign-in and hours it uses, else its glyph. */
function inkTip(cluster: SendCluster, words: string | null, reason: string | undefined, payer: SendPayer | null): string | undefined {
  if (cluster.kind === "stop") return payer?.stop ?? "Stop";
  if (cluster.kind === "turn") return reason ?? payer?.[cluster.enter] ?? undefined;
  if (cluster.kind === "note") return reason ?? NOTE_TIP;
  if (words) return reason;
  return reason ?? payer?.send ?? "Send";
}

/**
 * The send cluster at the composer bar's end. The ink button is one button through every state: the bare arrow with
 * nothing running, the one Stop with nothing typed while something runs, and a pill carrying the word of what Enter
 * does mid-turn, so a turn starting or ending swaps it in place. Mid-turn, Stop steps aside as a white key and the other
 * way waits beside the pill as a quiet word, dimmed with its reason when the turn cannot take it. While an ask waits with
 * nothing typed, the ink is the ask's and Stop stands alone as the white key. In a cloud thread others are in, each says
 * on demand whose sign-in and hours it uses (`payer`). A draft that tags a person makes the pill Post note, which says
 * on demand where the note goes; Stop stays beside it while something runs.
 */
export function ComposerSendCluster({
  cluster,
  canSend,
  block,
  stopping,
  onSend,
  onStop,
  payer = null,
}: {
  cluster: SendCluster;
  canSend: boolean;
  /** Why nothing can be sent, said on demand by the dimmed send. */
  block: string | null;
  stopping: boolean;
  /** `other` is the quiet word's way rather than Enter's. */
  onSend: (other: boolean) => void;
  onStop: () => void;
  payer?: SendPayer | null | undefined;
}) {
  const reason = canSend ? undefined : (block ?? undefined);
  return (
    <div className="composer-send-cluster">
      {cluster.kind === "asked" || (cluster.kind !== "stop" && cluster.stop) ? <StopKey stopping={stopping} onStop={onStop} tip={payer?.stop ?? "Stop"} /> : null}
      {cluster.kind === "turn" ? (
        <button
          type="button"
          onClick={() => onSend(true)}
          disabled={!canSend || Boolean(cluster.other.blocked)}
          data-tip={cluster.other.blocked ?? reason ?? payer?.[cluster.other.way] ?? undefined}
          className="composer-send-other"
        >
          {WAY_WORDS[cluster.other.way]}
        </button>
      ) : null}
      {cluster.kind === "asked" ? null : <InkButton cluster={cluster} canSend={canSend} reason={reason} payer={payer} stopping={stopping} onSend={() => onSend(false)} onStop={onStop} />}
    </div>
  );
}

function StopKey({ stopping, onStop, tip }: { stopping: boolean; onStop: () => void; tip: string }) {
  return (
    <button type="button" onClick={onStop} disabled={stopping} aria-label="Stop" data-tip={tip} className="composer-stop">
      <span className="composer-stop-glyph" />
    </button>
  );
}

function InkButton({
  cluster,
  canSend,
  reason,
  payer,
  stopping,
  onSend,
  onStop,
}: {
  cluster: SendCluster;
  canSend: boolean;
  reason: string | undefined;
  payer: SendPayer | null;
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
      data-tip={inkTip(cluster, words, reason, payer)}
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
