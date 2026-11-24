import type { SendCluster, SendPayer, SendWay } from "@openorc/client";
import { useState } from "react";
import { NOTE_TIP } from "./composer-notes";
import { ArrowUp, Queue } from "./icons";

const WAY_NAMES: Record<SendWay, string> = { now: "Send now", queue: "Queue" };
const WAY_GLYPHS = { now: ArrowUp, queue: Queue } as const;
const START_WORDS = "Start from the task";
const NOTE_WORDS = "Post note";

/** The words the ink button carries, if any: that an empty send starts the task, or that the draft posts as a note. */
function inkWords(cluster: SendCluster): string | null {
  if (cluster.kind === "note") return NOTE_WORDS;
  if (cluster.kind === "send" && cluster.startsTask) return START_WORDS;
  return null;
}

/** The glyph the ink button shows: the square while it stops, the pile while Enter queues, else the arrow. */
function inkGlyph(cluster: SendCluster): "send" | "queue" | "stop" {
  if (cluster.kind === "stop") return "stop";
  return cluster.kind === "turn" && cluster.enter === "queue" ? "queue" : "send";
}

/** The ink button's name: Stop, the way Enter sends mid-turn, its words, else Send. */
function inkName(cluster: SendCluster): string {
  if (cluster.kind === "stop") return "Stop";
  if (cluster.kind === "turn") return WAY_NAMES[cluster.enter];
  return inkWords(cluster) ?? "Send";
}

/** The last words the button carried, kept while they fold away, so the pill narrows with its words still in it. */
function useFoldingWords(words: string | null): string {
  const [last, setLast] = useState(words ?? "");
  if (words && words !== last) setLast(words);
  return words ?? last;
}

/** What the ink button says on demand: why it cannot be pressed, else whose sign-in and hours it uses, else its name. */
function inkTip(cluster: SendCluster, reason: string | undefined, payer: SendPayer | null): string | undefined {
  if (cluster.kind === "stop") return payer?.stop ?? "Stop";
  if (cluster.kind === "turn") return reason ?? payer?.[cluster.enter] ?? WAY_NAMES[cluster.enter];
  if (cluster.kind === "note") return reason ?? NOTE_TIP;
  if (cluster.kind === "send" && cluster.startsTask) return reason;
  return reason ?? payer?.send ?? "Send";
}

/**
 * The send cluster at the composer bar's end. The ink button is one button through every state: the bare arrow with
 * nothing running, the one Stop with nothing typed while something runs, and mid-turn the glyph of what Enter does, so
 * a turn starting or ending swaps it in place. Mid-turn, Stop and the other way stand beside it as white keys its own
 * size, the other way dimmed with its reason when the turn cannot take it; each says its name on demand. While an ask
 * waits with nothing typed, the ink is the ask's and Stop stands alone as the white key. In a cloud thread others are
 * in, each says on demand whose sign-in and hours it uses (`payer`). A draft that tags a person makes the ink a pill
 * that says Post note, which says on demand where the note goes; Stop stays beside it while something runs. `quiet`,
 * while the message is dictated, the cluster keeps only Stop and the ink button: the other way and the pill's words
 * step aside.
 */
export function ComposerSendCluster({
  cluster,
  canSend,
  block,
  stopping,
  onSend,
  onStop,
  payer = null,
  quiet = false,
}: {
  cluster: SendCluster;
  quiet?: boolean;
  canSend: boolean;
  /** Why nothing can be sent, said on demand by the dimmed send. */
  block: string | null;
  stopping: boolean;
  /** `other` is the white key's way rather than Enter's. */
  onSend: (other: boolean) => void;
  onStop: () => void;
  payer?: SendPayer | null | undefined;
}) {
  const reason = canSend ? undefined : (block ?? undefined);
  return (
    <div className="composer-send-cluster">
      {cluster.kind === "asked" || (cluster.kind !== "stop" && cluster.stop) ? <StopKey stopping={stopping} onStop={onStop} tip={payer?.stop ?? "Stop"} /> : null}
      {cluster.kind === "turn" && !quiet ? (
        <WayKey
          way={cluster.other.way}
          disabled={!canSend || Boolean(cluster.other.blocked)}
          tip={cluster.other.blocked ?? reason ?? payer?.[cluster.other.way] ?? WAY_NAMES[cluster.other.way]}
          onSend={() => onSend(true)}
        />
      ) : null}
      {cluster.kind === "asked" ? null : <InkButton cluster={cluster} canSend={canSend} reason={reason} payer={payer} stopping={stopping} quiet={quiet} onSend={() => onSend(false)} onStop={onStop} />}
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

/** The way Enter does not take, as a white key beside the ink button. */
function WayKey({ way, disabled, tip, onSend }: { way: SendWay; disabled: boolean; tip: string; onSend: () => void }) {
  const Glyph = WAY_GLYPHS[way];
  return (
    <button type="button" onClick={onSend} disabled={disabled} aria-label={WAY_NAMES[way]} data-tip={tip} className="composer-way">
      <Glyph size={16} />
    </button>
  );
}

function InkButton({
  cluster,
  canSend,
  reason,
  payer,
  stopping,
  quiet,
  onSend,
  onStop,
}: {
  cluster: SendCluster;
  canSend: boolean;
  reason: string | undefined;
  payer: SendPayer | null;
  stopping: boolean;
  quiet: boolean;
  onSend: () => void;
  onStop: () => void;
}) {
  const named = inkWords(cluster);
  // Quiet, the words fold away and the arrow carries them as its name and its tip instead.
  const words = quiet ? null : named;
  const folding = useFoldingWords(words);
  const stops = cluster.kind === "stop";
  return (
    <button
      type="button"
      onClick={stops ? onStop : onSend}
      disabled={stops ? stopping : !canSend}
      aria-label={inkName(cluster)}
      data-tip={quiet && named ? (reason ?? named) : inkTip(cluster, reason, payer)}
      data-state={inkGlyph(cluster)}
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
        <span className="composer-send-layer" data-layer="queue">
          <Queue size={16} />
        </span>
        <span className="composer-send-layer" data-layer="stop">
          <span className="composer-stop-glyph" />
        </span>
      </span>
    </button>
  );
}
