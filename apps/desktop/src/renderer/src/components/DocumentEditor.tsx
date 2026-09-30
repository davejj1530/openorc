import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref, type RefObject } from "react";
import { createPortal } from "react-dom";
import { EditorContent, useEditor, type Editor, type UseEditorOptions } from "@tiptap/react";
import { BubbleMenu, type BubbleMenuProps } from "@tiptap/react/menus";
import type { EditorView } from "@tiptap/pm/view";
import Placeholder from "@tiptap/extension-placeholder";
import { Bold, Code2, Image, Italic, Link2, Plus, Strikethrough } from "./icons";
import { ThreadMedia } from "./ThreadImages";
import { IMAGE_ACCEPT } from "../lib/image-imports";
import { CoversPreview } from "../lib/browser-preview";
import { documentExtensions } from "./editor/document-schema";
import { LinkEditor } from "./editor/LinkEditor";
import { TaskImage } from "./editor/TaskImage";
import { matchingCommands } from "./editor/commands";
import { useDocumentCommands } from "./editor/use-document-commands";
import { useDocumentImages } from "./editor/use-document-images";
import { useDocumentMode } from "./editor/use-document-mode";
import { IconButton, Tooltip } from "./ui";
import "./editor/document-editor.css";

export type DocumentEditorHandle = { focus: () => void; flush: () => Promise<boolean> };
type Props = { value: string; onChange: (value: string) => void; basePath?: string; disabled?: boolean; onReadyChange?: (ready: boolean) => void; ref?: Ref<DocumentEditorHandle> };
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
function editorOptions(content: string, handlers: RefObject<EditorHandlers | null>): UseEditorOptions {
  return {
    extensions: [...documentExtensions(TaskImage), Placeholder.configure({ placeholder: "Describe the work… Type / for commands, or paste an image.", showOnlyCurrent: true })],
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
export function DocumentEditor({ value, onChange, basePath, disabled = false, onReadyChange, ref }: Props) {
  const [error, setError] = useState("");
  const [link, setLink] = useState<string | null>(null);
  // Link editing ends with the menu it sits in, when the selection moves on.
  const [menuOptions] = useState<BubbleMenuProps["options"]>(() => ({ placement: "top", offset: 8, onHide: () => setLink(null) }));
  const handlers = useRef<EditorHandlers | null>(null);
  const plainPaste = useRef(false);
  const [options] = useState(() => editorOptions(value, handlers));
  const editor = useEditor(options);
  const images = useDocumentImages(onReadyChange, setError);
  const mode = useDocumentMode(editor, value, onChange);
  const { source } = mode;

  useEffect(() => {
    editor?.setEditable(!disabled, false);
  }, [editor, disabled]);

  const addImages = (files: File[], position?: number) => {
    if (!editor || disabled) return;
    setError("");
    commands.setMenu(null);
    images.stage(editor, files, position);
  };
  const pickImage = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = IMAGE_ACCEPT;
    input.multiple = true;
    input.onchange = () => addImages(Array.from(input.files ?? []));
    input.click();
  };
  const commands = useDocumentCommands(editor, source, pickImage);
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
    flush: () => images.flush(editor, source, value),
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
        { label: "Bold (⌘B)", Icon: Bold, run: () => editor.chain().focus().toggleBold().run() },
        { label: "Italic (⌘I)", Icon: Italic, run: () => editor.chain().focus().toggleItalic().run() },
        { label: "Strikethrough", Icon: Strikethrough, run: () => editor.chain().focus().toggleStrike().run() },
        { label: "Inline code", Icon: Code2, run: () => editor.chain().focus().toggleCode().run() },
        { label: "Edit link (⌘K)", Icon: Link2, run: () => setLink(String(editor.getAttributes("link").href ?? "")) },
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
        <div className="task-editor-controls">
          {source ? null : (
            <>
              <Tooltip label="Insert content">
                <IconButton type="button" disabled={disabled} aria-label="Insert content" onMouseDown={(event) => event.preventDefault()} onClick={commands.open}>
                  <Plus size={15} />
                </IconButton>
              </Tooltip>
              <Tooltip label="Insert image">
                <IconButton type="button" disabled={disabled} aria-label="Insert image" onMouseDown={(event) => event.preventDefault()} onClick={pickImage}>
                  <Image size={15} />
                </IconButton>
              </Tooltip>
            </>
          )}
          <button type="button" className="task-editor-mode" disabled={images.busy} onClick={switchMode}>
            {source ? "Rich text" : "Markdown"}
          </button>
        </div>
        <div hidden={source}>
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
        {source ? (
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
        {commands.menu && !source
          ? createPortal(
              <div className="task-insert-menu" style={{ left: commands.menu.left, top: commands.menu.top, transform: commands.menu.above ? "translateY(-100%)" : undefined }}>
                <CoversPreview />
                <div className="task-insert-heading">Insert {commands.menu.query ? <span>“{commands.menu.query}”</span> : null}</div>
                <div id="task-insert-options" role="listbox" aria-label="Insert content">
                  {matchingCommands(commands.menu.query).map((command, index) => (
                    <button
                      type="button"
                      role="option"
                      id={`task-insert-${index}`}
                      aria-selected={commands.highlight === index}
                      key={command.id}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => commands.setHighlight(index)}
                      onClick={() => commands.choose(index)}
                    >
                      <command.icon size={17} />
                      <span>{command.label}</span>
                      <small>{command.hint}</small>
                    </button>
                  ))}
                  {matchingCommands(commands.menu.query).length === 0 ? <p className="task-insert-empty">No matching commands</p> : null}
                </div>
                <div className="task-insert-footer">↑↓ to navigate · Enter to insert · Esc to close</div>
              </div>,
              document.body,
            )
          : null}
      </div>
    </ThreadMedia>
  );
}
