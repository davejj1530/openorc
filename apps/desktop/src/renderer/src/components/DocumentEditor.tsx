import { useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { EditorContent, useEditor, type Editor, type UseEditorOptions } from "@tiptap/react";
import { BubbleMenu, type BubbleMenuProps } from "@tiptap/react/menus";
import type { EditorView } from "@tiptap/pm/view";
import Placeholder from "@tiptap/extension-placeholder";
import { Bold, Code2, Image, Italic, Link2, Plus, Strikethrough } from "./icons";
import { ThreadMedia } from "./ThreadImages";
import { documentExtensions } from "./editor/document-schema";
import { LinkEditor } from "./editor/LinkEditor";
import { TaskImage } from "./editor/TaskImage";
import { SharedTaskImage } from "./editor/SharedTaskImage";
import { validateOnlineTaskSpec } from "../lib/task-online-spec";
import { DocumentInsertMenu } from "./editor/DocumentInsertMenu";
import { documentImageInput } from "./editor/document-image-input";
import { useDocumentCommands } from "./editor/use-document-commands";
import { useDocumentImages } from "./editor/use-document-images";
import { useDocumentMode } from "./editor/use-document-mode";
import { IconButton, Tooltip } from "./ui";
import "./editor/document-editor.css";

/** `replace` swaps in a whole new description as one edit, so in rich text undo brings back what was there. */
export type DocumentEditorHandle = { focus: () => void; flush: () => Promise<boolean>; replace: (markdown: string) => void };
type Props = {
  value: string;
  onChange: (value: string) => void;
  basePath?: string;
  disabled?: boolean;
  imageUnavailableReason?: string;
  onReadyChange?: (ready: boolean) => void;
  ref?: Ref<DocumentEditorHandle>;
  controls?: ReactNode;
  /** Takes the controls row's place while something else has the document, such as a Refine at work. */
  bar?: ReactNode;
  /** Shown instead of the editor, which stays mounted with its history, such as a suggestion to review. */
  replacement?: ReactNode;
};
type EditorHandlers = {
  update: (editor: Editor) => void;
  selectionChange: (editor: Editor) => void;
  create: (editor: Editor) => void;
  keyDown: (view: EditorView, event: KeyboardEvent) => boolean;
  paste: (event: ClipboardEvent) => boolean;
  drop: (view: EditorView, event: DragEvent) => boolean;
};

// Plain text that reads as Markdown is pasted as formatting.
const MARKDOWN_TEXT = /(^#{1,6} |^[-*+>] |^\d+[.)] |^```|\*\*|!\[|\]\()/m;

/** Created once per mount; handlers reach the current render through `handlers`. */
function editorOptions(content: string, handlers: RefObject<EditorHandlers | null>, imageUnavailableReason?: string): UseEditorOptions {
  return {
    extensions: [
      ...documentExtensions(imageUnavailableReason ? SharedTaskImage : TaskImage),
      Placeholder.configure({ placeholder: imageUnavailableReason ? "Describe the work… Type / for commands." : "Describe the work… Type / for commands, or paste an image.", showOnlyCurrent: true }),
    ],
    content,
    contentType: "markdown",
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: "task-rich-editor", role: "textbox", "aria-label": "Task description", "aria-multiline": "true", spellcheck: "true" },
      handleKeyDown: (view, event) => handlers.current?.keyDown(view, event) ?? false,
      handlePaste: (_view, event) => handlers.current?.paste(event) ?? false,
      handleDrop: (view, event, _slice, moved) => !moved && (handlers.current?.drop(view, event) ?? false),
    },
    // Only edits are saved. Plugins also append changes to a click, such as the
    // paragraph TrailingNode adds after a closing list; saving those would rewrite
    // an untouched document.
    onUpdate: ({ editor, transaction }) => {
      if (transaction.docChanged) handlers.current?.update(editor);
    },
    onSelectionUpdate: ({ editor }) => handlers.current?.selectionChange(editor),
    onCreate: ({ editor }) => handlers.current?.create(editor),
  };
}

/** Rich editing transactions stay local; Markdown remains the task/MCP persistence boundary. */
export function DocumentEditor({ value, onChange, basePath, disabled = false, onReadyChange, imageUnavailableReason, ref, controls, bar, replacement }: Props) {
  const [error, setError] = useState("");
  const [link, setLink] = useState<string | null>(null);
  // Link editing ends with the menu it sits in, when the selection moves on.
  const [menuOptions] = useState<BubbleMenuProps["options"]>(() => ({ placement: "top", offset: 8, onHide: () => setLink(null) }));
  const handlers = useRef<EditorHandlers | null>(null);
  const plainPaste = useRef(false);
  const [options] = useState(() => editorOptions(value, handlers, imageUnavailableReason));
  const editor = useEditor(options);
  const images = useDocumentImages(onReadyChange, setError);
  const mode = useDocumentMode(editor, value, onChange);
  const { source } = mode;

  useEffect(() => {
    editor?.setEditable(!disabled, false);
  }, [editor, disabled]);

  const { add: addImages, pick: pickImage } = documentImageInput(editor, disabled, imageUnavailableReason, images.stage, () => commands.setMenu(null), setError);
  const commands = useDocumentCommands(editor, source, pickImage, imageUnavailableReason);
  handlers.current = {
    update: (current) => {
      mode.emitRich(current);
      images.reportReady(current);
      commands.syncMenu(current);
    },
    selectionChange: (current) => commands.syncMenu(current),
    create: (current) => images.reportReady(current),
    keyDown: (view, event) => {
      plainPaste.current = (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "v";
      if (event.isComposing || view.composing) return false;
      if (commands.handleKeyDown(event)) return true;
      // Keep editor formatting shortcuts from toggling global shell controls.
      if ((event.metaKey || event.ctrlKey) && ["b", "i", "k", "e", "z"].includes(event.key.toLowerCase())) {
        event.stopPropagation();
        if (event.key.toLowerCase() === "k" && editor) {
          event.preventDefault();
          // A caret inside a link edits the whole link; elsewhere a link needs selected text.
          if (view.state.selection.empty) editor.commands.extendMarkRange("link");
          if (!editor.state.selection.empty) setLink(String(editor.getAttributes("link").href ?? ""));
          return true;
        }
      }
      return false;
    },
    paste: (event) => {
      if (disabled || !editor) return false;
      const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
      if (files.length) {
        event.preventDefault();
        addImages(files);
        return true;
      }
      const text = event.clipboardData?.getData("text/plain") ?? "";
      const plain = plainPaste.current;
      plainPaste.current = false;
      if (plain || event.clipboardData?.getData("text/html") || !MARKDOWN_TEXT.test(text)) return false;
      event.preventDefault();
      editor.commands.insertContent(text, { contentType: "markdown" });
      return true;
    },
    drop: (view, event) => {
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (!files.length || disabled) return false;
      event.preventDefault();
      addImages(files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos);
      return true;
    },
  };
  useImperativeHandle(ref, () => ({
    focus: mode.focus,
    replace: (markdown) => {
      if (source || !editor?.markdown) mode.emitSource(markdown);
      else editor.commands.setContent(editor.markdown.parse(markdown), { emitUpdate: true });
    },
    flush: () => {
      if (!imageUnavailableReason) return images.flush(editor, source, value);
      try {
        validateOnlineTaskSpec(value);
        return Promise.resolve(true);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
        return Promise.resolve(false);
      }
    },
  }));

  const shouldShowMenu = useCallback<NonNullable<BubbleMenuProps["shouldShow"]>>(
    ({ editor: current, state }) => !source && current.isEditable && !state.selection.empty && state.doc.textBetween(state.selection.from, state.selection.to).length > 0,
    [source],
  );
  const switchMode = () => {
    commands.setMenu(null);
    setLink(null);
    mode.toggleSource();
  };
  const formatButtons = editor
    ? [
        { label: "Bold", Icon: Bold, run: () => editor.chain().focus().toggleBold().run() },
        { label: "Italic", Icon: Italic, run: () => editor.chain().focus().toggleItalic().run() },
        { label: "Strikethrough", Icon: Strikethrough, run: () => editor.chain().focus().toggleStrike().run() },
        { label: "Inline code", Icon: Code2, run: () => editor.chain().focus().toggleCode().run() },
        { label: "Edit link", Icon: Link2, run: () => setLink(String(editor.getAttributes("link").href ?? "")) },
      ]
    : [];
  return (
    <ThreadMedia scopeKey="task-editor" basePath={basePath}>
      <div
        className="document-editor"
        onKeyDown={(event) => {
          if (commands.menu && ["Enter", "Escape", "ArrowUp", "ArrowDown"].includes(event.key)) event.stopPropagation();
        }}
      >
        {bar ?? (
          <div className="task-editor-controls">
            {source ? null : (
              <>
                <Tooltip label="Insert content">
                  <IconButton type="button" disabled={disabled} aria-label="Insert content" onMouseDown={(event) => event.preventDefault()} onClick={commands.open}>
                    <Plus size={15} />
                  </IconButton>
                </Tooltip>
                <Tooltip label={imageUnavailableReason ?? "Insert image"}>
                  <IconButton type="button" disabled={disabled || Boolean(imageUnavailableReason)} aria-label="Insert image" onMouseDown={(event) => event.preventDefault()} onClick={pickImage}>
                    <Image size={15} />
                  </IconButton>
                </Tooltip>
              </>
            )}
            {controls}
            <button type="button" className="task-editor-mode" disabled={images.busy} onClick={switchMode}>
              {source ? "Rich text" : "Markdown"}
            </button>
          </div>
        )}
        {replacement}
        <div hidden={source || Boolean(replacement)}>
          <EditorContent editor={editor} />
          {editor ? (
            <BubbleMenu editor={editor} options={menuOptions} shouldShow={shouldShowMenu}>
              {link === null ? (
                <div className="task-format-menu" role="toolbar" aria-label="Text formatting">
                  {formatButtons.map(({ label, Icon, run }) => (
                    <Tooltip key={label} label={label}>
                      <IconButton type="button" aria-label={label} onMouseDown={(event) => event.preventDefault()} onClick={run}>
                        <Icon size={15} />
                      </IconButton>
                    </Tooltip>
                  ))}
                </div>
              ) : (
                <LinkEditor editor={editor} initial={link} onClose={() => setLink(null)} />
              )}
            </BubbleMenu>
          ) : null}
        </div>
        {source && !replacement ? (
          <textarea
            ref={mode.sourceInput}
            aria-label="Task description Markdown"
            className="document-description task-source-editor"
            value={value}
            disabled={disabled}
            onChange={(event) => mode.emitSource(event.target.value)}
          />
        ) : null}
        {error ? (
          <p className="task-editor-error" role="alert">
            {error}{" "}
            <button type="button" onClick={() => setError("")}>
              Dismiss
            </button>
          </p>
        ) : null}
        <DocumentInsertMenu commands={commands} source={source} imageUnavailableReason={imageUnavailableReason} />
      </div>
    </ThreadMedia>
  );
}
