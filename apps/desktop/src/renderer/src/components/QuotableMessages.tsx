import { Popover } from "@base-ui/react/popover";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CoversPreview } from "../lib/browser-preview";
import { floatingGround } from "../lib/use-anchor-ground";
import { QuoteNote } from "./ComposerQuote";

const HIGHLIGHT = "quoted-passage";

/** The words selected inside one of the pane's messages, once the pointer lifts. */
function selectedPassage(pane: HTMLElement): { text: string; range: Range } | null {
  const selection = pane.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const text = selection.toString().trim();
  const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  if (!text || !pane.contains(range.commonAncestorContainer) || !start?.closest(".journal-message")) return null;
  return { text, range: range.cloneRange() };
}

/**
 * The conversation's messages, filling the room over the composer, whose words can be quoted: selecting some opens a
 * note under them, and saving it hands the passage and the note to `onQuote`. The note takes the keyboard only when
 * clicked, so a selection can still be copied; the passage stays marked while the note is written.
 */
export function QuotableMessages({ children, onQuote }: { children: ReactNode; onQuote: (text: string, note: string) => void }) {
  const pane = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<{ text: string; range: Range } | null>(null);
  useEffect(() => {
    const element = pane.current;
    if (!element) return;
    // A click on selected words clears them only after the pointer lifts, so the selection is read a frame later.
    const read = () => requestAnimationFrame(() => setPicked(selectedPassage(element)));
    // A drag that starts in the messages may end anywhere; one that starts elsewhere, as in the note, is not theirs.
    const begin = () => document.addEventListener("pointerup", read, { once: true });
    element.addEventListener("pointerdown", begin);
    return () => {
      element.removeEventListener("pointerdown", begin);
      document.removeEventListener("pointerup", read);
    };
  }, []);
  useEffect(() => {
    if (!picked) return;
    CSS.highlights.set(HIGHLIGHT, new Highlight(picked.range));
    return () => void CSS.highlights.delete(HIGHLIGHT);
  }, [picked]);
  const anchor = useMemo(() => (picked ? { getBoundingClientRect: () => picked.range.getBoundingClientRect(), contextElement: pane.current ?? undefined } : null), [picked]);
  return (
    <div ref={pane} className="flex-1 min-h-0 relative">
      {children}
      <Popover.Root open={picked !== null} onOpenChange={(open) => void (open || setPicked(null))}>
        <Popover.Portal>
          <CoversPreview />
          <Popover.Positioner anchor={anchor} side="bottom" align="start" sideOffset={8} collisionPadding={12}>
            <Popover.Popup ref={floatingGround} initialFocus={false} finalFocus={false} className="quote-popup composer-float" aria-label="Quote in your reply">
              <QuoteNote
                note=""
                onSave={(note) => {
                  if (picked) onQuote(picked.text, note);
                  document.getSelection()?.removeAllRanges();
                  setPicked(null);
                }}
              />
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
