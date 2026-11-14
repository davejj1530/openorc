import { Popover } from "@base-ui/react/popover";
import { Button } from "./ui";
import { formatTokens } from "@openorc/client";
import { CoversPreview } from "../lib/browser-preview";
import { floatingGround } from "../lib/use-anchor-ground";
import { useHostedControlReason } from "./HostedConversationBoundary";
import { HostedControlReason } from "./HostedControlReason";

/** How full reads as a warning: warn above 60%, bad above 85%. */
function fullness(fraction: number): "warn" | "bad" | undefined {
  if (fraction > 0.85) return "bad";
  if (fraction > 0.6) return "warn";
  return undefined;
}

const SHARE_RADIUS = 6.5;

/**
 * An amount at 16px and under: its share filled on a faint disc of its own ink, from the top, clockwise. A filled
 * share cannot be read as the loader's turning arc.
 */
export function AmountShare({ fraction, size = 14 }: { fraction: number; size?: number }) {
  const share = Math.min(1, Math.max(0, fraction));
  const angle = share * 2 * Math.PI;
  const x = 8 + SHARE_RADIUS * Math.sin(angle);
  const y = 8 - SHARE_RADIUS * Math.cos(angle);
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" className="amount-share">
      <circle cx="8" cy="8" r={SHARE_RADIUS} fill="currentColor" fillOpacity="0.2" />
      {share >= 1 ? <circle cx="8" cy="8" r={SHARE_RADIUS} fill="currentColor" /> : null}
      {share > 0 && share < 1 ? <path d={`M8 8V${8 - SHARE_RADIUS}A${SHARE_RADIUS} ${SHARE_RADIUS} 0 ${share > 0.5 ? 1 : 0} 1 ${x.toFixed(3)} ${y.toFixed(3)}Z`} fill="currentColor" /> : null}
    </svg>
  );
}

const RING_RADIUS = 6.125;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** An amount above 16px: the whole faint ring under its share. */
function AmountRing({ fraction }: { fraction: number }) {
  return (
    <svg width="32" height="32" viewBox="0 0 16 16" aria-hidden="true" className="composer-context-ring">
      <circle className="composer-context-track" cx="8" cy="8" r={RING_RADIUS} fill="none" strokeWidth="1.75" />
      <circle
        cx="8"
        cy="8"
        r={RING_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeDasharray={`${RING_LENGTH * fraction} ${RING_LENGTH}`}
        strokeLinecap="round"
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}

/** How full the conversation is: its share beside send, opening into the amount, two facts and the one action. */
export function ContextUsage({ used, window, onCompact, compacting, disabledReason }: { used: number; window: number | null; onCompact?: () => void; compacting?: boolean; disabledReason?: string }) {
  const fraction = window ? Math.min(1, used / window) : 0;
  const tone = fullness(fraction);
  return (
    <Popover.Root>
      <Popover.Trigger aria-label="Context usage" className="composer-context" data-tone={tone}>
        {window ? <AmountShare fraction={fraction} /> : null}
        <span className="composer-context-number">{window ? `${Math.round(fraction * 100)}%` : formatTokens(used)}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <CoversPreview />
        <Popover.Positioner side="top" align="end" sideOffset={6} collisionPadding={12}>
          <Popover.Popup ref={floatingGround} className="composer-context-popup composer-float">
            <Popover.Title className="composer-context-amount">
              {window ? (
                <span className="composer-context-ring-wrap" data-tone={tone}>
                  <AmountRing fraction={fraction} />
                </span>
              ) : null}
              <span className="tabular">
                {formatTokens(used)}
                {window ? <span className="composer-context-of"> of {formatTokens(window)}</span> : null}
              </span>
            </Popover.Title>
            <dl className="composer-context-stats">
              <div>
                <dt>Used</dt>
                <dd>{used.toLocaleString()} tokens</dd>
              </div>
              <div>
                <dt>Available</dt>
                <dd>{window ? `${Math.max(0, window - used).toLocaleString()} tokens` : "Not reported"}</dd>
              </div>
            </dl>
            <ContextCompact onCompact={onCompact} compacting={compacting} disabledReason={disabledReason} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The one action: dimmed with its reason on demand while it cannot run. */
function ContextCompact({ onCompact, compacting, disabledReason }: { onCompact?: (() => void) | undefined; compacting?: boolean | undefined; disabledReason?: string | undefined }) {
  const hostedReason = useHostedControlReason("compact");
  if (hostedReason)
    return (
      <div className="composer-context-compact">
        <HostedControlReason label="Compact context" reason={hostedReason}>
          <Button size="sm" variant="secondary" disabled>
            Compact context
          </Button>
        </HostedControlReason>
      </div>
    );
  const reason = compacting ? undefined : (disabledReason ?? (onCompact ? undefined : "Compacting isn’t available for this conversation."));
  return (
    <div className="composer-context-compact">
      <Button size="sm" variant="secondary" disabled={!onCompact || compacting || Boolean(disabledReason)} data-tip={reason} onClick={onCompact}>
        {compacting ? "Compacting…" : "Compact context"}
      </Button>
    </div>
  );
}
