import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, within } from "@testing-library/react";
import { createRef, useState, type RefObject } from "react";
import { getNearestEditorFromDOMNode, type LexicalEditor } from "lexical";
import { ComposerEditor, type ComposerEditorHandle, type ComposerEditorProps, type DraftChange } from "./ComposerEditor";
import { $readDraft, $writeDraft } from "./draft";

/** Drives a composer's message box in jsdom, which has no typing of its own, through the editor the person types into. */
function editorOf(field: HTMLElement): LexicalEditor {
  const editor = getNearestEditorFromDOMNode(field);
  if (!editor) throw new Error("No composer editor holds this element.");
  return editor;
}

/** The message the box holds, marks as the words they stand for. */
export const messageOf = (field: HTMLElement): string =>
  editorOf(field)
    .getEditorState()
    .read(() => $readDraft().text);

/** Where the caret is in the message, or null while the box has no selection. */
export const caretOf = (field: HTMLElement): number | null =>
  editorOf(field)
    .getEditorState()
    .read(() => $readDraft().caret);

/** Focuses the box and makes its words `text`, the caret at its end or at `caret`, as typing them would. */
export function type(field: HTMLElement, text: string, caret = text.length): void {
  act(() => {
    field.focus();
    editorOf(field).update(() => $writeDraft(text, caret), { discrete: true });
  });
}

/** Focuses the box and puts the caret at `caret` in its message, as a click there would. */
export function placeCaret(field: HTMLElement, caret: number): void {
  type(field, messageOf(field), caret);
}

export interface MountedEditor {
  field: HTMLElement;
  container: HTMLElement;
  /** Every change the box reported, in order. */
  changes: DraftChange[];
  handle: RefObject<ComposerEditorHandle | null>;
  /** Changes the message from outside, as a send clearing it or a saved draft coming back does. */
  setMessage: (text: string) => void;
}

/** One message box on its own, its owner keeping the message as a composer does, with whatever the test hands it. */
export function mountEditor(overrides: Partial<ComposerEditorProps> = {}): MountedEditor {
  const changes: DraftChange[] = [];
  const handle = (overrides.handle as RefObject<ComposerEditorHandle | null> | undefined) ?? createRef<ComposerEditorHandle>();
  const outside: { set: (text: string) => void } = { set: () => {} };
  function Owner() {
    const [value, setValue] = useState(overrides.value ?? "");
    outside.set = setValue;
    return (
      <ComposerEditor
        sources={{}}
        onKeyDown={() => false}
        onFiles={() => {}}
        disabled={false}
        placeholder="Message"
        completion={{}}
        onFocus={() => {}}
        onBlur={() => {}}
        handle={handle}
        {...overrides}
        value={value}
        onChange={(change) => {
          changes.push(change);
          if (change.edited) setValue(change.text);
          overrides.onChange?.(change);
        }}
      />
    );
  }
  // A mark draws an Orcling by its face, which it reads as the app does.
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <Owner />
    </QueryClientProvider>,
  );
  const setMessage = (text: string) => act(() => outside.set(text));
  return { container: view.container, field: within(view.container).getByRole("textbox", { name: "Message" }), changes, handle, setMessage };
}

/**
 * Runs an event on the box and lets the editor finish the update it starts. Lexical commits an event's edit on a
 * microtask, so without this a test would read the message from before the key.
 */
export function act$(field: HTMLElement, event: () => boolean): boolean {
  let result = true;
  act(() => {
    result = event();
    editorOf(field).read(() => {});
  });
  return result;
}

/** Presses a key in the box, as `fireEvent.keyDown` does, with the edit it makes finished. */
export const press = (field: HTMLElement, init: KeyboardEventInit & { keyCode?: number }): boolean => act$(field, () => fireEvent.keyDown(field, init));
