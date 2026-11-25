import { Popover } from "@base-ui/react/popover";
import { useState } from "react";
import { CoversPreview } from "../lib/browser-preview";
import type { Quote } from "@openorc/client";
import { floatingGround } from "../lib/use-anchor-ground";
import { composing } from "./composer-editor/shared";
import { Quote as QuoteIcon, X } from "./icons";
import { Button, Textarea } from "./ui";

/** The note on a passage: Enter saves it, Shift and Enter starts a line. The passage shows where it is not already in view. */
export function QuoteNote({ passage, note, focus, onSave }: { passage?: string; note: string; focus?: boolean; onSave: (note: string) => void }) {
  const [draft, setDraft] = useState(note);
  const save = () => onSave(draft.trim());
  return (
    <form
      className="quote-note"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      {passage ? <p className="quote-note-passage">{passage}</p> : null}
      <Textarea
        rows={3}
        autoFocus={focus}
        aria-label="Note"
        placeholder="Add a note"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || composing(event.nativeEvent)) return;
          event.preventDefault();
          save();
        }}
      />
      <Button type="submit" size="sm" variant="primary" className="justify-self-end">
        Save
      </Button>
    </form>
  );
}

/** A quote in the draft: the passage over its note. It opens into the whole passage and the note to change. */
export function ComposerQuote({ quote, edit, remove }: { quote: Quote; edit: (note: string) => void; remove: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="composer-attachment">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger className="composer-file composer-quote" aria-label={`Quote: ${quote.text}`}>
          <QuoteIcon size={18} />
          <span className="composer-file-text">
            <span className="composer-file-name">{quote.text}</span>
            {quote.note ? <span className="composer-file-size composer-quote-note">{quote.note}</span> : null}
          </span>
        </Popover.Trigger>
        <Popover.Portal>
          <CoversPreview />
          <Popover.Positioner side="top" align="start" sideOffset={6} collisionPadding={12}>
            <Popover.Popup ref={floatingGround} className="quote-popup composer-float">
              <QuoteNote
                passage={quote.text}
                note={quote.note}
                focus
                onSave={(note) => {
                  edit(note);
                  setOpen(false);
                }}
              />
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <button type="button" onClick={remove} aria-label="Remove quote" className="composer-remove-image">
        <X size={11} />
      </button>
    </div>
  );
}
