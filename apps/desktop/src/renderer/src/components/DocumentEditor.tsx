import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import Placeholder from "@tiptap/extension-placeholder";
import { Bold, Code2, Image, Italic, Link2, Plus, Strikethrough } from "./icons";
import { ThreadMedia, ThreadRichText } from "./ThreadImages";
import { IMAGE_ACCEPT } from "../lib/image-imports";
import { CoversPreview } from "../lib/browser-preview";
import { canEditRichly, documentExtensions } from "./editor/document-schema";
import { TaskImage } from "./editor/TaskImage";
import { matchingCommands } from "./editor/commands";
import { useDocumentCommands } from "./editor/use-document-commands";
import { useDocumentImages } from "./editor/use-document-images";
import { useDocumentMode } from "./editor/use-document-mode";
import { IconButton, Tooltip } from "./ui";
import "./editor/document-editor.css";

export type DocumentEditorHandle = { focus: () => void; flush: () => Promise<boolean> };
type Props = { value: string; onChange: (value: string) => void; disabled?: boolean; onReadyChange?: (ready: boolean) => void; ref?: Ref<DocumentEditorHandle> };

/** Rich editing transactions stay local; Markdown remains the task/MCP persistence boundary. */
export function DocumentEditor({ value, onChange, disabled = false, onReadyChange, ref }: Props) {
  const [initiallyRich] = useState(() => canEditRichly(value));
  const [error, setError] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const images = useDocumentImages(onReadyChange, setError);
  const busy = images.busy;
  const insertFiles = useRef<(files: File[], position?: number) => void>(() => {});
  const commandCallbacks = useRef<{ syncMenu: (editor: Editor) => void; handleKeyDown: (event: KeyboardEvent) => boolean } | null>(null);
  const modeCallbacks = useRef<{ emitRich: (editor: Editor) => void } | null>(null);
  const pasteMarkdown = useRef<(text: string) => void>(() => {});
  const plainPaste = useRef(false);
  const editor = useEditor({
    extensions: [...documentExtensions(TaskImage), Placeholder.configure({ placeholder: "Describe the work… Type / for commands, or paste an image.", showOnlyCurrent: true })],
    content: initiallyRich ? value : "",
    contentType: "markdown",
    editable: !disabled,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: "task-rich-editor", role: "textbox", "aria-label": "Task description", "aria-multiline": "true", spellcheck: "true" },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
        if (disabledRef.current) return false;
        if (files.length) {
          event.preventDefault();
          insertFiles.current(files);
          return true;
        }
        const text = event.clipboardData?.getData("text/plain") ?? "";
        const plain = plainPaste.current;
        plainPaste.current = false;
        if (!plain && !event.clipboardData?.getData("text/html") && /(^#{1,3} |^[-*>] |^\d+\. |^```|\*\*|!\[)/m.test(text) && canEditRichly(text)) {
          event.preventDefault();
          pasteMarkdown.current(text);
          return true;
        }
        return false;
      },
      handleDrop: (view, event, _slice, moved) => {
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (moved || !files.length || disabledRef.current) return false;
        event.preventDefault();
        insertFiles.current(files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos);
        return true;
      },
      handleKeyDown: (view, event) => {
        plainPaste.current = (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "v";
        if (event.isComposing || view.composing) return false;
        if (commandCallbacks.current?.handleKeyDown(event)) return true;
        // Keep editor formatting shortcuts from toggling global shell controls.
        if ((event.metaKey || event.ctrlKey) && ["b", "i", "k", "e", "z"].includes(event.key.toLowerCase())) {
          event.stopPropagation();
          if (event.key.toLowerCase() === "k") {
            event.preventDefault();
            setLink(String(view.state.selection.$from.marks().find((mark) => mark.type.name === "link")?.attrs.href ?? ""));
            return true;
          }
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => {
      modeCallbacks.current?.emitRich(editor);
      images.reportReady(editor);
      commandCallbacks.current?.syncMenu(editor);
    },
    onSelectionUpdate: ({ editor }) => commandCallbacks.current?.syncMenu(editor),
    onCreate: ({ editor }) => images.reportReady(editor),
  });
  const mode = useDocumentMode(editor, value, onChange, initiallyRich, images.reportReady);
  modeCallbacks.current = mode;
  const { source, sourcePreview, notice, sourceInput } = mode;

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);
  pasteMarkdown.current = (text) => {
    editor?.commands.insertContent(text, { contentType: "markdown" });
  };

  const addImages = (files: File[], position?: number) => {
    if (!editor || disabled) return;
    setError("");
    commands.setMenu(null);
    images.stage(editor, files, position);
  };
  insertFiles.current = addImages;
  const pickImage = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = IMAGE_ACCEPT;
    input.multiple = true;
    input.onchange = () => addImages(Array.from(input.files ?? []));
    input.click();
  };
  const commands = useDocumentCommands(editor, source, pickImage);
  commandCallbacks.current = commands;
  useImperativeHandle(ref, () => ({
    focus: mode.focus,
    flush: () => images.flush(editor, source, value),
  }));

  const switchMode = () => {
    commands.setMenu(null);
    setLink(null);
    mode.switchMode();
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
  const applyLink = () => {
    if (!editor || link === null) return;
    const href = link.trim();
    if (!href) editor.chain().focus().extendMarkRange("link").unsetLink().run();
    else if (/^(https?:\/\/|mailto:)/i.test(href)) editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    else {
      setError("Use a link beginning with https://, http://, or mailto:.");
      return;
    }
    setLink(null);
    setError("");
  };
  return (
    <ThreadMedia scopeKey="task-editor">
      <div
        className="document-editor"
        onKeyDown={(event) => {
          if (commands.menu && ["Enter", "Escape", "ArrowUp", "ArrowDown"].includes(event.key)) event.stopPropagation();
        }}
      >
        <div className="task-editor-controls">
          {!source ? (
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
              <span className="task-editor-hint">Text, images, and / commands</span>
            </>
          ) : (
            <span className="task-editor-hint">Markdown source</span>
          )}
          {source ? (
            <button type="button" className="task-editor-mode" onClick={mode.toggleSourcePreview}>
              {sourcePreview ? "Edit source" : "Preview"}
            </button>
          ) : null}
          <button type="button" className="task-editor-mode" disabled={busy} onClick={switchMode}>
            {source ? "Rich text" : "Markdown"}
          </button>
        </div>
        {notice && source ? (
          <p className="task-editor-notice" role="status">
            {notice}
          </p>
        ) : null}
        <div hidden={source}>
          <EditorContent editor={editor} />
          {editor ? (
            <BubbleMenu
              editor={editor}
              options={{ placement: "top", offset: 8 }}
              shouldShow={({ editor, state }) => !source && editor.isEditable && !state.selection.empty && state.doc.textBetween(state.selection.from, state.selection.to).length > 0}
            >
              <div className="task-format-menu" role="toolbar" aria-label="Text formatting">
                {formatButtons.map(({ label, Icon, run }) => (
                  <Tooltip key={label} label={label}>
                    <IconButton type="button" aria-label={label} onMouseDown={(event) => event.preventDefault()} onClick={run}>
                      <Icon size={15} />
                    </IconButton>
                  </Tooltip>
                ))}
              </div>
            </BubbleMenu>
          ) : null}
        </div>
        {source &&
          (sourcePreview ? (
            <div className="document-preview prose-chat">
              <ThreadRichText>{value || "Nothing to preview yet."}</ThreadRichText>
            </div>
          ) : (
            <textarea
              ref={sourceInput}
              aria-label="Task description Markdown"
              className="document-description task-source-editor"
              value={value}
              disabled={disabled}
              onChange={(event) => mode.emitSource(event.target.value)}
              onSelect={mode.rememberSourceSelection}
            />
          ))}
        {link !== null && editor ? (
          <div
            role="group"
            aria-label="Edit link"
            className="task-link-editor"
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                applyLink();
              }
              if (event.key === "Escape") {
                setLink(null);
                editor.commands.focus();
              }
            }}
          >
            <input autoFocus aria-label="Link URL" placeholder="https://example.com" value={link} onChange={(event) => setLink(event.target.value)} />
            <button type="button" onClick={applyLink}>
              {link ? "Apply link" : "Remove link"}
            </button>
            <button
              type="button"
              onClick={() => {
                setLink(null);
                editor.commands.focus();
              }}
            >
              Cancel
            </button>
          </div>
        ) : null}
        {busy ? (
          <p className="task-editor-notice" role="status">
            Images are saving. Your text remains editable.
          </p>
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
