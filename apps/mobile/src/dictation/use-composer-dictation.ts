import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { TextInputInstance } from "react-native";
import { haptic } from "../ui/haptics";
import type { DictationNoticeKind, DictationPhase, Spoken } from "./dictation";
import { dictation, useDictation } from "./phone-dictation";
import { withSpoken } from "./spoken";

export interface ComposerDictation {
  /** Where this composer's recording is; null while it has none. */
  phase: DictationPhase | null;
  /** When it began to hear. */
  since: number | null;
  notice: DictationNoticeKind | null;
  /** Starts dictating into the draft, or finishes and keeps the words. */
  toggle: () => void;
  /** Stops and takes the words back out. */
  cancel: () => void;
  /** The prompt's field, for the keyboard to come back to. */
  input: RefObject<TextInputInstance | null>;
  /** The prompt says where its caret or selection is, as it moves. */
  onSelection: (selection: { start: number; end: number }) => void;
}

interface Draft {
  /** The composer's own name among the app's composers: one records at a time. */
  owner: string;
  text: string;
  onText: (text: string) => void;
  /** Puts the caret here once the words are in. */
  onCaret: (caret: number) => void;
}

/**
 * Dictation for one composer. Spoken words are written into its draft where the caret was, in place of what was
 * selected, as they are heard; the draft takes no typing meanwhile. The keyboard comes back to the draft if it had it,
 * however the recording ends. A draft that becomes another conversation's ends the recording, since its words belong
 * to the first.
 */
export function useComposerDictation({ owner, text, onText, onCaret }: Draft): ComposerDictation {
  const input = useRef<TextInputInstance>(null);
  // Where the caret or the selection last was; null while the prompt never had one, and the words go at its end.
  const selection = useRef<{ start: number; end: number } | null>(null);
  const onSelection = useCallback((held: { start: number; end: number }) => {
    selection.current = held;
  }, []);
  const take = useDictation((state) => (state.take?.owner === owner ? state.take : null));
  const notice = useDictation((state) => (state.notice?.owner === owner ? state.notice.kind : null));
  const draft = useRef({ text, onText, onCaret });
  useEffect(() => {
    draft.current = { text, onText, onCaret };
  });
  const speak = useCallback((): Spoken => {
    const original = draft.current.text;
    const held = selection.current ?? { start: original.length, end: original.length };
    const edges = [held.start, held.end].map((edge) => Math.min(edge, original.length));
    const place = { text: original, from: Math.min(...edges), to: Math.max(...edges) };
    const keyboard = input.current?.isFocused() ?? false;
    let caret = place.from;
    return {
      say(words) {
        const next = withSpoken(place, words);
        caret = next.caret;
        draft.current.onText(next.text);
      },
      end(keep) {
        if (!keep) {
          caret = place.from;
          draft.current.onText(original);
        }
        selection.current = { start: caret, end: caret };
        draft.current.onCaret(caret);
        haptic.tap();
        // The prompt takes typing again only once this is drawn.
        if (keyboard) requestAnimationFrame(() => input.current?.focus());
      },
    };
  }, []);
  const toggle = useCallback(() => {
    if (dictation.store.getState().take?.owner === owner) return void dictation.finish();
    haptic.tap();
    void dictation.start(owner, speak);
  }, [owner, speak]);
  useEffect(
    () => () => {
      if (dictation.store.getState().take?.owner === owner) dictation.cancel();
    },
    [owner],
  );
  // What the microphone had to say is answered by writing on.
  const said = useRef(text);
  useEffect(() => {
    if (said.current !== text && notice && !take) dictation.dismissNotice();
    said.current = text;
  }, [text, notice, take]);
  return { phase: take?.phase ?? null, since: take?.since ?? null, notice, toggle, cancel: dictation.cancel, input, onSelection };
}

/**
 * Sending while dictating. A send asked for mid-recording finishes the recording first and goes once the last words
 * are in the draft. A recording that is cancelled sends nothing.
 */
export function useDictatedSend(owner: string, submit: () => void): () => void {
  const dictating = useDictation((state) => state.take?.owner === owner);
  const latest = useRef(submit);
  useEffect(() => {
    latest.current = submit;
  });
  // The send that waited, handed on through a render so it goes with the draft as the last words left it.
  const [due, setDue] = useState<object | null>(null);
  const gone = useRef(due);
  useEffect(() => {
    if (!due || gone.current === due) return;
    gone.current = due;
    latest.current();
  }, [due]);
  return useCallback(() => {
    if (!dictating) return latest.current();
    void dictation.finish().then((kept) => {
      if (kept) setDue({});
    });
  }, [dictating]);
}
