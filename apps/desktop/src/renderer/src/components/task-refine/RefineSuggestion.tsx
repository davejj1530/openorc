import { useEffect, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { documentExtensions } from "../editor/document-schema";
import { TaskImage } from "../editor/TaskImage";
import { ThreadMedia } from "../ThreadImages";
import { alignGutters, refineDecorations, refineMarksKey, RefineMarks } from "./refine-marks";

export function RefineSuggestion({ base, suggestion, basePath }: { base: string; suggestion: string; basePath?: string }) {
  const [options] = useState(() => ({
    extensions: [...documentExtensions(TaskImage), RefineMarks],
    content: suggestion,
    contentType: "markdown" as const,
    editable: false,
    shouldRerenderOnTransaction: false,
    editorProps: { attributes: { class: "task-rich-editor refine-document", role: "document", "aria-label": "Suggested task description" } },
  }));
  const editor = useEditor(options);

  useEffect(() => {
    if (!editor || editor.isDestroyed || !editor.markdown) return;
    const baseDoc = base.trim() ? editor.schema.nodeFromJSON(editor.markdown.parse(base)) : editor.schema.topNodeType.createAndFill()!;
    editor.view.dispatch(editor.state.tr.setMeta(refineMarksKey, refineDecorations(editor.state.doc, baseDoc)));
    const frame = requestAnimationFrame(() => alignGutters(editor.view.dom));
    return () => cancelAnimationFrame(frame);
  }, [editor, base]);

  return (
    <ThreadMedia scopeKey="task-refine" basePath={basePath}>
      <EditorContent editor={editor} />
    </ThreadMedia>
  );
}
