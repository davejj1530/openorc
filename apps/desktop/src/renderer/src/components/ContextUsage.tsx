import { Popover } from "@base-ui/react/popover";
import { Button } from "./ui";
import { cn } from "../lib/cn";
import { formatTokens } from "../lib/time";
import { CoversPreview } from "../lib/browser-preview";
import { floatingGround } from "../lib/use-anchor-ground";

const CELLS = 20;
const RING_RADIUS = 6;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

function ringTone(fraction: number): string | undefined {
  if (fraction > 0.85) return "text-bad";
  if (fraction > 0.6) return "text-warn";
  return undefined;
}

/** How full the conversation is, as a bare ring that opens into the figures. Only the explicit action compacts. */
export function ContextUsage({ used, window, onCompact, compacting, disabledReason }: { used: number; window: number | null; onCompact?: () => void; compacting?: boolean; disabledReason?: string }) {
  const fraction = window ? Math.min(1, used / window) : 0;
  const percent = Math.round(fraction * 100);
  const filled = Math.round(fraction * CELLS);
  return (
    <Popover.Root>
      <Popover.Trigger aria-label="Context usage" className={cn("composer-context", ringTone(fraction))} data-tone={ringTone(fraction) ? "alert" : undefined}>
        {window ? (
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <circle className="composer-context-track" cx="8" cy="8" r={RING_RADIUS} fill="none" strokeWidth="2" />
            <circle
              cx="8"
              cy="8"
              r={RING_RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeDasharray={`${RING_LENGTH * fraction} ${RING_LENGTH}`}
              strokeLinecap="round"
              transform="rotate(-90 8 8)"
            />
          </svg>
        ) : null}
        <span>{window ? `${percent}%` : formatTokens(used)}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <CoversPreview />
        <Popover.Positioner side="top" align="end" sideOffset={6} collisionPadding={12}>
          <Popover.Popup ref={floatingGround} className="composer-context-popup composer-float">
            <div className="composer-context-head">
              <Popover.Title className="composer-context-title">Context</Popover.Title>
              <span className="tabular">{window ? `${formatTokens(used)} of ${formatTokens(window)}` : formatTokens(used)}</span>
            </div>
            {window ? (
              <div className="composer-context-cells" aria-hidden="true">
                {Array.from({ length: CELLS }, (_, index) => (
                  <span key={index} data-filled={index < filled || undefined} />
                ))}
              </div>
            ) : null}
            <Popover.Description className="composer-context-note">Context is the messages, instructions, and tool results the model can use in this conversation.</Popover.Description>
            <ContextFigures used={used} window={window} percent={percent} />
            <ContextCompact onCompact={onCompact} compacting={compacting} disabledReason={disabledReason} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ContextFigures({ used, window, percent }: { used: number; window: number | null; percent: number }) {
  return (
    <dl className="composer-context-stats">
      <div>
        <dt>Used</dt>
        <dd>
          {used.toLocaleString()} tokens{window ? ` (${percent}%)` : ""}
        </dd>
      </div>
      {window ? (
        <>
          <div>
            <dt>Available</dt>
            <dd>{Math.max(0, window - used).toLocaleString()} tokens</dd>
          </div>
          <div>
            <dt>Context window</dt>
            <dd>{window.toLocaleString()} tokens</dd>
          </div>
        </>
      ) : (
        <div>
          <dt>Context window</dt>
          <dd>Not reported</dd>
        </div>
      )}
    </dl>
  );
}

function ContextCompact({ onCompact, compacting, disabledReason }: { onCompact?: () => void; compacting?: boolean; disabledReason?: string }) {
  return (
    <div className="composer-context-compact">
      <p className="composer-context-note">Compacting summarizes earlier messages to free up space. Some detail may be lost.</p>
      <Button size="sm" variant="secondary" disabled={!onCompact || compacting || Boolean(disabledReason)} onClick={onCompact}>
        {compacting ? "Compacting…" : "Compact context"}
      </Button>
      {compacting || !onCompact || disabledReason ? (
        <p role="status" className="composer-context-note">
          {compacting ? "Compacting context. New messages will be queued." : (disabledReason ?? "Compaction is unavailable for this conversation right now.")}
        </p>
      ) : null}
    </div>
  );
}
