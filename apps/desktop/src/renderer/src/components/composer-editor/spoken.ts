import { HISTORY_MERGE_TAG, HISTORY_PUSH_TAG, type LexicalEditor } from "lexical";
import { $readDraft, $selectionSpan, $writeDraft } from "./draft";

/** Words being dictated into the draft: `say` rewrites them as more is heard, `end` keeps them or takes them back out. */
export interface Spoken {
  say: (words: string) => void;
  end: (keep: boolean) => void;
}

/**
 * Starts spoken words where the caret was, in place of what was selected, with a space on either side where the
 * message needs one. However often they are rewritten, they undo as one step. The draft is not editable while it is
 * spoken into, so the page keeps no caret to follow: words spoken at the end keep the end in view.
 */
export function speakInto(editor: LexicalEditor): Spoken {
  const { text, span } = editor.getEditorState().read(() => ({ text: $readDraft().text, span: $selectionSpan() }));
  const from = span ? Math.min(span.anchor, span.focus) : text.length;
  const before = text.slice(0, from);
  const after = span ? text.slice(Math.max(span.anchor, span.focus)) : "";
  let said = false;
  const write = (next: string, caret: number) => {
    editor.update(() => $writeDraft(next, caret), { discrete: true, tag: said ? HISTORY_MERGE_TAG : HISTORY_PUSH_TAG });
    said = true;
  };
  return {
    say(words) {
      // Nothing heard, or nothing any more: what was selected stays as it was.
      if (!words) return void (said && write(text, from));
      const head = before + (before && !/\s$/.test(before) ? " " : "") + words;
      write(head + (after && !/^\s/.test(after) ? " " : "") + after, head.length);
      const root = editor.getRootElement();
      if (root && !after) root.scrollTop = root.scrollHeight;
    },
    end(keep) {
      if (!keep && said) write(text, from);
    },
  };
}
