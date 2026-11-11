import { createContext, useContext, useState, type ReactNode } from "react";
import type { Block, ObjectState, WorkChip } from "@openorc/client";
import { Check, Loader2, X } from "./icons";

/** How raw blocks render: the transcript's own rows. `details` draws a call as its details alone, under its chip. */
export type RenderBlocks = (blocks: Block[], details?: boolean) => ReactNode;

/** Whether an object's call is open. Held by the object's group, so it survives the drawing changing kind. */
export const CallOpen = createContext<[boolean, (update: (open: boolean) => boolean) => void]>([false, () => {}]);

/** Holds the open state for the rows inside it. */
export function CallOpenScope({ children }: { children: ReactNode }) {
  const state = useState(false);
  return <CallOpen.Provider value={state}>{children}</CallOpen.Provider>;
}

/**
 * An object's row, the handle of the call behind it: pressing it opens that call in place, in place of the excerpt
 * under the row.
 */
export function CallRow({ chip, calls, renderBlocks, under, children }: { chip: WorkChip; calls: Block[]; renderBlocks: RenderBlocks; under?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useContext(CallOpen);
  return (
    <>
      <OpenedCall open={open} calls={calls} renderBlocks={renderBlocks}>
        <button type="button" className="work-chip" data-kind={chip.kind} data-tip={chip.title} aria-pressed={open} onClick={() => setOpen((value) => !value)}>
          {children}
        </button>
      </OpenedCall>
      {open ? null : under}
    </>
  );
}

/** A chip, and once it is pressed the call behind it, grown out of the chip on its fill with the chip as its head. */
export function OpenedCall({ open, calls, renderBlocks, children }: { open: boolean; calls: Block[]; renderBlocks: RenderBlocks; children: ReactNode }) {
  return (
    <div className="work-call" data-open={open || undefined}>
      {children}
      {open ? (
        <div className="work-call-body">
          <div className="work-call-details">{renderBlocks(calls, true)}</div>
        </div>
      ) : null}
    </div>
  );
}

/** Running, done or failed, as a mark. A row says only what is unusual: `quiet` leaves a finished one unmarked. */
export function StateMark({ state, size = 14, quiet = false }: { state: ObjectState; size?: number; quiet?: boolean }) {
  if (state === "running") return <Loader2 size={size} className="tool-row-live work-object-mark" />;
  if (state === "failed") return <X size={size} className="work-object-mark" data-tone="bad" />;
  return state === "done" && !quiet ? <Check size={size} className="work-object-mark" /> : null;
}

const blockTone = (index: number, good: number, filled: number) => {
  if (index < good) return "ok";
  return index < filled ? "bad" : undefined;
};

/** A change's size as five blocks: added in green, removed in red, the rest empty. Bigger changes fill more of them. */
export function SizeBlocks({ added, removed }: { added: number; removed: number }) {
  const total = added + removed;
  const scale = total ? Math.min(5, Math.max(1, Math.ceil(Math.log2(total + 1) / 1.6))) : 0;
  const good = total ? Math.round((added / total) * scale) : 0;
  return (
    <span className="work-size-blocks" aria-hidden="true">
      {Array.from({ length: 5 }, (_, index) => (
        <span key={index} data-tone={blockTone(index, good, scale)} />
      ))}
    </span>
  );
}

/** "+8 −3", added first, as the change card and the diff head read it. */
export function SizeStat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="work-size-stat">
      {added || !removed ? <span className="work-stat-added">+{added}</span> : null}
      {removed ? <span className="work-stat-removed">−{removed}</span> : null}
    </span>
  );
}
