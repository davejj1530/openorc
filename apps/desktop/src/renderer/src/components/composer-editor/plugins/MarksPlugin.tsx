import {
  $addUpdateTag,
  $hasUpdateTag,
  BLUR_COMMAND,
  COMMAND_PRIORITY_LOW,
  HISTORY_MERGE_TAG,
  LineBreakNode,
  mergeRegister,
  ParagraphNode,
  SELECTION_CHANGE_COMMAND,
  SKIP_DOM_SELECTION_TAG,
  SKIP_SCROLL_INTO_VIEW_TAG,
  TextNode,
} from "lexical";
import { useLayoutEffect, useMemo } from "react";
import { markPieces, sourcesKey, type MarkSources } from "../../../lib/message-marks";
import { $markDraft } from "../draft";
import { MARK_NODES, type SkillNode } from "../nodes";
import { hasFocus, useLatest } from "../shared";
import { useEditor } from "../editor";

/** An update whose draft has been read for marks already. */
const MARKED = "composer-marked";

/**
 * Draws what the message names as marks, read from its words alone, so typing, pasting, undoing and a draft coming
 * back all mark the same way. A name typed in full lands once the caret moves on; a list arriving or changing reads
 * the draft again, as no step to undo. Nothing is marked while an input method composes.
 */
export function MarksPlugin({ sources }: { sources: MarkSources }) {
  const editor = useEditor();
  // Read again only when what the words may name changes, not each time an owner builds its lists anew.
  const key = sourcesKey(sources);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for `sources`.
  const read = useMemo(() => (text: string) => markPieces(text, sources), [key]);
  const latest = useLatest(read);
  // Registered before the first draft is written in (see ComposerEditor's order): registering a transform runs it over
  // every node already there, in an update that would move the page's selection into the box.
  useLayoutEffect(() => {
    // Every node an edit touches calls this, and the whole draft is read once per update: a long paste is thousands of nodes.
    const mark = () => {
      if (editor.isComposing() || $hasUpdateTag(MARKED)) return;
      $addUpdateTag(MARKED);
      $markDraft(latest.current, hasFocus(editor));
    };
    // The caret moving on or leaving lets a name that waited at it land.
    const settle = (defer: boolean) => {
      // A mark landing belongs to the step that moved the caret, not a step of its own.
      if (!editor.isComposing() && $markDraft(latest.current, defer)) $addUpdateTag(HISTORY_MERGE_TAG);
      return false;
    };
    return mergeRegister(
      editor.registerNodeTransform(TextNode, mark),
      editor.registerNodeTransform(LineBreakNode, mark),
      editor.registerNodeTransform(ParagraphNode, mark),
      ...MARK_NODES.map((klass) => editor.registerNodeTransform(klass as typeof SkillNode, mark)),
      editor.registerCommand(SELECTION_CHANGE_COMMAND, () => settle(true), COMMAND_PRIORITY_LOW),
      editor.registerCommand(BLUR_COMMAND, () => settle(false), COMMAND_PRIORITY_LOW),
    );
  }, [editor, latest]);
  useLayoutEffect(() => {
    editor.update(
      () => {
        if (!editor.isComposing() && $markDraft(read, hasFocus(editor))) $addUpdateTag(HISTORY_MERGE_TAG);
      },
      { discrete: true, tag: hasFocus(editor) ? [] : [SKIP_DOM_SELECTION_TAG, SKIP_SCROLL_INTO_VIEW_TAG] },
    );
  }, [editor, read]);
  return null;
}
