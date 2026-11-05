import { cn } from "../lib/cn";
import { ChevronDown, CircleCheck, FileDiff, GitPullRequest, Globe, Lightbulb, Terminal, Upload, WorkDelegate, X } from "./icons";
import type { ReceiptItem } from "@openorc/client";

/** A pull request reads as one; a push, a commit or a failure on the way reads as sending. */
function itemIcon(item: ReceiptItem) {
  if (item.failed) return X;
  if (item.kind === "git") return item.label.startsWith("#") ? GitPullRequest : Upload;
  return { thought: Lightbulb, steps: CircleCheck, check: Terminal, tests: CircleCheck, changes: FileDiff, agents: WorkDelegate, sources: Globe }[item.kind];
}

/**
 * What a turn's work came to, as one quiet row of icons and words under its head: the pull request it opened, the
 * size of its changes, its last tests. The row is the work's disclosure: clicking it opens the steps below.
 */
export function TurnReceipt({ items, open, controls, onToggle }: { items: ReceiptItem[]; open: boolean; controls: string; onToggle: () => void }) {
  return (
    <button type="button" className="turn-receipt" aria-expanded={open} aria-controls={controls} aria-label={items.map((item) => item.label).join(", ") || "Work"} onClick={onToggle}>
      {items.map((item) => {
        const Icon = itemIcon(item);
        return (
          <span key={`${item.kind}:${item.label}`} className="turn-receipt-item" data-kind={item.kind} data-tone={item.failed ? "bad" : undefined}>
            <Icon size={14} />
            {item.label}
          </span>
        );
      })}
      <ChevronDown size={14} className={cn("turn-receipt-chevron", open && "rotate-180")} />
    </button>
  );
}
