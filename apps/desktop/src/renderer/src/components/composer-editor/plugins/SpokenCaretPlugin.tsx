import { $getSelection, $isRangeSelection, mergeRegister, type LexicalEditor } from "lexical";
import { useEffect, useRef } from "react";
import { useEditor } from "../editor";
import { SPOKEN } from "../shared";

/** Where the draft's caret is drawn on the page, or null where it is not on a line of words in view. */
function caretBox(editor: LexicalEditor): DOMRect | null {
  const root = editor.getRootElement();
  const point = editor.getEditorState().read(() => {
    const selection = $getSelection();
    return $isRangeSelection(selection) ? { key: selection.focus.key, offset: selection.focus.offset, type: selection.focus.type } : null;
  });
  const element = point && editor.getElementByKey(point.key);
  if (!root || !point || !element) return null;
  const range = root.ownerDocument.createRange();
  if (point.type === "text") {
    const words = element.firstChild;
    if (!words) return null;
    range.setStart(words, Math.min(point.offset, words.textContent?.length ?? 0));
  } else range.setStart(element, Math.min(point.offset, element.childNodes.length));
  range.collapse(true);
  // A caret between lines has two boxes; the last is the line the next word goes on. An empty draft has none.
  const box = [...range.getClientRects()].at(-1) ?? (point.type === "element" && point.offset === 0 ? element.getBoundingClientRect() : null);
  const view = root.getBoundingClientRect();
  return box && box.top >= view.top - 1 && box.bottom <= view.bottom + 1 ? box : null;
}

/**
 * The mark of where dictated words land. A draft that is spoken into cannot be typed in, so the page draws it no
 * caret; this one stands at the end of the spoken words and glides along the line as they arrive. Onto another line
 * it steps, as a caret does. It goes when the draft can be typed in again and has its own caret back.
 */
export function SpokenCaret() {
  const editor = useEditor();
  const mark = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let line: number | null = null;
    const hide = () => {
      line = null;
      if (mark.current) mark.current.hidden = true;
    };
    return mergeRegister(
      editor.registerUpdateListener(({ tags }) => {
        const caret = mark.current;
        const shell = caret?.parentElement;
        if (!tags.has(SPOKEN) || !caret || !shell) return;
        const box = caretBox(editor);
        if (!box) return hide();
        const origin = shell.getBoundingClientRect();
        const top = Math.round(box.top - origin.top);
        caret.dataset.step = String(top !== line);
        caret.style.height = `${box.height}px`;
        caret.style.transform = `translate(${box.left - origin.left}px, ${top}px)`;
        caret.hidden = false;
        line = top;
      }),
      editor.registerEditableListener((editable) => {
        if (editable) hide();
      }),
    );
  }, [editor]);
  return <span ref={mark} className="composer-spoken-caret" aria-hidden="true" hidden />;
}
