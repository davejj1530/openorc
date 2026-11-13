import type { LexicalEditor } from "lexical";
import { useLayoutEffect, useRef } from "react";

/** An update that writes the message from outside, as a send clearing it or a draft coming back: not the person's edit. */
export const EXTERNAL = "composer-external";

/** Whether the person is in the draft now. An update made while they are not must not take focus or move the page's selection. */
export const hasFocus = (editor: LexicalEditor): boolean => {
  const root = editor.getRootElement();
  return Boolean(root && root.contains(root.ownerDocument.activeElement));
};

/** The latest value, read from listeners registered once. */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/** Whether a key press belongs to an input method composing text. Safari marks the key that ends a composition only with code 229. */
export const composing = (event: KeyboardEvent): boolean => event.isComposing || event.keyCode === 229;
