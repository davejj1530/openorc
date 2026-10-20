import { ArrowUp, Clock } from "./icons";
import { Tooltip } from "./ui";

export type ComposerSendState = "send" | "queue" | "stop";

const labels: Record<ComposerSendState, string> = { send: "Send", queue: "Queue", stop: "Stop" };

/**
 * The composer's one ink control. Send, Queue and Stop are layers of the same button, so a turn
 * starting or ending swaps the glyph in place with a small overshoot instead of replacing it.
 */
export function ComposerSendButton({ state, disabled, hint, onClick }: { state: ComposerSendState; disabled: boolean; hint: string; onClick: () => void }) {
  return (
    <Tooltip label={hint}>
      <button type="button" onClick={onClick} disabled={disabled} aria-label={labels[state]} data-state={state} className="composer-send">
        <span className="composer-send-layer" data-layer="send" aria-hidden="true">
          <ArrowUp size={16} />
        </span>
        <span className="composer-send-layer" data-layer="queue" aria-hidden="true">
          <Clock size={16} />
        </span>
        <span className="composer-send-layer" data-layer="stop" aria-hidden="true">
          <span className="composer-stop-glyph" />
        </span>
      </button>
    </Tooltip>
  );
}
