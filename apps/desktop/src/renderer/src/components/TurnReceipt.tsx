import { cn } from "../lib/cn";
import { ChevronDown, CircleCheck, Lightbulb, Terminal } from "./icons";
import type { ReceiptItem } from "./work-receipt";

const icons = { thought: Lightbulb, steps: CircleCheck, check: Terminal } as const;

/**
 * What a turn's work came to, as one quiet row of icons and words under its head. The row is the work's disclosure:
 * clicking it opens the steps below.
 */
export function TurnReceipt({ items, open, controls, onToggle }: { items: ReceiptItem[]; open: boolean; controls: string; onToggle: () => void }) {
  return (
    <button type="button" className="turn-receipt" aria-expanded={open} aria-controls={controls} aria-label={items.map((item) => item.label).join(", ") || "Work"} onClick={onToggle}>
      {items.map((item) => {
        const Icon = icons[item.kind];
        return (
          <span key={item.kind} className="turn-receipt-item" data-tone={item.failed ? "bad" : undefined}>
            <Icon size={14} />
            {item.label}
          </span>
        );
      })}
      <ChevronDown size={14} className={cn("turn-receipt-chevron", open && "rotate-180")} />
    </button>
  );
}
