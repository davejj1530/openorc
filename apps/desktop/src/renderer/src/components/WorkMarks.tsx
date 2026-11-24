import type { ReactNode } from "react";
import type { Block, ObjectState, WorkChip } from "@openorc/client";
import { Brain, Check, Folder, Globe, Hammer, Search, Terminal, WorkDelegate, X } from "./icons";
import { Spinner } from "./Spinner";
import { FileGlyph } from "./FileGlyph";

/** How raw blocks render: the transcript's own rows. `details` draws a call as its details alone, under its chip. */
export type RenderBlocks = (blocks: Block[], details?: boolean) => ReactNode;

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
  if (state === "running") return <Spinner size={size} className="tool-row-live work-object-mark" />;
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

const kindIcons = { folder: Folder, query: Search, command: Terminal, intent: Terminal, web: Globe, tool: Hammer, agent: WorkDelegate, memory: Brain } as const;

/** A file shows its language's mark; anything else shows what kind of thing it is. */
export function ChipIcon({ chip }: { chip: WorkChip }) {
  if (chip.kind === "file" || chip.kind === "edit") return <FileGlyph path={chip.label} size={14} className="work-chip-icon" />;
  const Icon = kindIcons[chip.kind];
  return <Icon size={14} className="work-chip-icon" />;
}
