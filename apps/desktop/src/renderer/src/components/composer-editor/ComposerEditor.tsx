import { HISTORY_MERGE_TAG, HISTORY_PUSH_TAG } from "lexical";
import { useEffect, useImperativeHandle, useRef, type AriaAttributes, type FocusEventHandler, type PointerEventHandler, type Ref } from "react";
import type { MarkSources } from "../../lib/message-marks";
import { $readDraft, $writeDraft } from "./draft";
import { EditorBox, EditorPlaceholder, EditorProvider, useEditable, useEditor } from "./editor";
import { MARK_NODES } from "./nodes";
import { ClipboardPlugin } from "./plugins/ClipboardPlugin";
import { DraftPlugin, type DraftChange } from "./plugins/DraftPlugin";
import { FocusPlugin } from "./plugins/FocusPlugin";
import { KeyboardPlugin } from "./plugins/KeyboardPlugin";
import { LandingPlugin } from "./plugins/LandingPlugin";
import { MarksPlugin } from "./plugins/MarksPlugin";
import { ReadyPlugin } from "./plugins/ReadyPlugin";
import { PICKED } from "./shared";
import { speakInto, type Spoken } from "./spoken";

export type { DraftChange } from "./plugins/DraftPlugin";
export type { Spoken } from "./spoken";

/**
 * What the composer does to its draft, each as one step to undo with the caret where it belongs: a pick from a list
 * writes the message, and its pills land with a pop; `write` puts words back, as a queued message returning, and
 * nothing moves; `begin` starts an `@` or `/` word where the person was, as the plus menu does; `focus` puts the keyboard
 * back in the words where the caret was, as a docked ask hands it back; `speak` starts dictated words at the caret.
 */
export interface ComposerEditorHandle {
  pick: (text: string, caret: number) => void;
  write: (text: string, caret: number) => void;
  /** Starts a word at `at`, apart from the word before it. */
  begin: (start: string, at: number) => void;
  focus: () => void;
  speak: () => Spoken;
}

export interface ComposerEditorProps {
  /** The message, as its owner keeps it. */
  value: string;
  onChange: (change: DraftChange) => void;
  /** What its words may name, each drawn as its own mark. */
  sources: MarkSources;
  /** Keys the composer answers ahead of the editor: true for each it took. */
  onKeyDown: (event: KeyboardEvent) => boolean;
  onFiles: (files: File[]) => void;
  /** The person is about to write: the field took focus, or its first words, which come with it. */
  onReady?: ((why?: "focus" | "words", message?: string) => void) | undefined;
  disabled: boolean;
  placeholder: string;
  autoFocus?: boolean | undefined;
  /** The list completing the word at the caret, for a screen reader. */
  completion: Pick<AriaAttributes, "aria-controls" | "aria-activedescendant">;
  onFocus: FocusEventHandler<HTMLDivElement>;
  onBlur: FocusEventHandler<HTMLDivElement>;
  onPointerMove?: PointerEventHandler<HTMLDivElement>;
  onPointerLeave?: PointerEventHandler<HTMLDivElement>;
  handle: Ref<ComposerEditorHandle>;
  /** The element the words are in, which marks are found in by where they are drawn. */
  rootRef?: Ref<HTMLDivElement>;
}

/** The composer's handle and its editable state, which belong to the editor rather than to any one concern. */
function EditorControls({ handle, disabled }: Pick<ComposerEditorProps, "handle" | "disabled">) {
  const editor = useEditor();
  const editable = useEditable(editor);
  useEffect(() => editor.setEditable(!disabled), [editor, disabled]);
  // A box that cannot be typed in cannot take the keyboard. Asked for meanwhile, it comes once the box can, with the
  // caret where the draft has it: words written while it could not be typed in moved the draft's caret and not the
  // page's, and an update made outside an event would otherwise start from the page's.
  const awaited = useRef(false);
  useEffect(() => {
    if (!editable || !awaited.current) return;
    awaited.current = false;
    const { text, caret } = editor.getEditorState().read($readDraft);
    editor.update(() => $writeDraft(text, caret ?? text.length), { discrete: true, tag: HISTORY_MERGE_TAG });
    editor.getRootElement()?.focus({ preventScroll: true });
  }, [editor, editable]);
  useImperativeHandle(handle, () => {
    const writeAs = (tags: string[]) => (text: string, caret: number) => {
      editor.update(() => $writeDraft(text, caret), { discrete: true, tag: tags });
      editor.getRootElement()?.focus({ preventScroll: true });
    };
    const begin = (start: string, from: number) => {
      // In first, so the caret the update leaves is the person's and the list at it opens.
      editor.getRootElement()?.focus({ preventScroll: true });
      editor.update(
        () => {
          const { text } = $readDraft();
          const at = Math.min(from, text.length);
          const word = at > 0 && !/\s/.test(text[at - 1]!) ? ` ${start}` : start;
          $writeDraft(text.slice(0, at) + word + text.slice(at), at + word.length);
        },
        { discrete: true, tag: HISTORY_PUSH_TAG },
      );
    };
    return {
      pick: writeAs([HISTORY_PUSH_TAG, PICKED]),
      write: writeAs([HISTORY_PUSH_TAG]),
      begin,
      focus: () => {
        const root = editor.getRootElement();
        if (root?.getAttribute("contenteditable") === "false") awaited.current = true;
        else root?.focus({ preventScroll: true });
      },
      speak: () => speakInto(editor),
    };
  }, [editor]);
  return null;
}

/**
 * The message box every composer writes in: plain words with each skill, connector, member and picked file as a mark
 * of its own. Each concern is one plugin: the message in and out (Draft), marks (Marks), keys (Keyboard), the clipboard
 * and drops (Clipboard), the ready signal (Ready), focus on mount (Focus) and a picked pill landing (Landing); plain text editing and undo come with the
 * editor itself.
 */
export function ComposerEditor(props: ComposerEditorProps) {
  return (
    <EditorProvider namespace="composer" nodes={MARK_NODES}>
      <div className="composer-input-shell">
        <EditorBox
          ref={props.rootRef}
          aria-label="Message"
          aria-multiline
          aria-autocomplete="list"
          aria-controls={props.completion["aria-controls"]}
          aria-activedescendant={props.completion["aria-activedescendant"]}
          aria-placeholder={props.placeholder}
          spellCheck
          onFocus={props.onFocus}
          onBlur={props.onBlur}
          onPointerMove={props.onPointerMove}
          onPointerLeave={props.onPointerLeave}
          className="composer-input min-w-0 outline-none text-ink"
        />
        <EditorPlaceholder>
          <span className="composer-placeholder">{props.placeholder}</span>
        </EditorPlaceholder>
      </div>
      {/* Marks registers how it reads the words before Draft writes the first message in. */}
      <MarksPlugin sources={props.sources} />
      <LandingPlugin />
      <DraftPlugin value={props.value} onChange={props.onChange} />
      <KeyboardPlugin onKeyDown={props.onKeyDown} />
      <ClipboardPlugin onFiles={props.onFiles} />
      {props.onReady ? <ReadyPlugin onReady={props.onReady} /> : null}
      <FocusPlugin autoFocus={Boolean(props.autoFocus)} />
      <EditorControls handle={props.handle} disabled={props.disabled} />
    </EditorProvider>
  );
}
