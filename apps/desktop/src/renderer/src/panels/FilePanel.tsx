import { Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CodeEditor, type LineRange } from "../components/code-editor";
import { Button } from "../components/ui";
import { ThreadMedia, ThreadRichText } from "../components/ThreadImages";
import { hasUnsavedEdits } from "../lib/file-buffer";
import { flushDrafts, useDrafts } from "../lib/file-drafts";
import type { FileSelection } from "../lib/layout";
import { useFileBuffer, type FileBuffer } from "../lib/use-file-buffer";
import { useFileExplorer } from "../lib/file-explorer";
import { FileExplorer } from "./FileExplorer";
import { ExplorerResizeHandle } from "./ExplorerResizeHandle";
import { FileToolbar, type FileView } from "./FileToolbar";

const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** One range per cited selection, so the editor reveals it once however often the page renders. */
const reveals = new WeakMap<FileSelection, LineRange>();
function revealOf(selection: FileSelection): LineRange | null {
  if (!selection.line) return null;
  if (!reveals.has(selection)) reveals.set(selection, { start: selection.line, end: selection.endLine ?? selection.line });
  return reveals.get(selection) ?? null;
}

/** A file in the conversation's folder, edited in place. Markdown also renders, and a cited line opens the source there. */
export function FilePanel({ selection, directory }: { selection: FileSelection; directory: string }) {
  const buffer = useFileBuffer(selection);
  const markdown = isMarkdown(selection.path);
  const [chosen, choose] = useState<{ selection: FileSelection; view: FileView } | null>(null);
  let view: FileView = selection.line ? "source" : "preview";
  if (chosen?.selection === selection) view = chosen.view;
  const frame = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(false);
  const [overlayFor, setOverlayFor] = useState<string | null>(null);
  const visible = useFileExplorer((state) => state.visible);
  const width = useFileExplorer((state) => state.width);
  const treeVisible = compact ? overlayFor === selection.path : visible;
  const explorerStyle: CSSProperties & { "--file-explorer-width": string } = { "--file-explorer-width": `${width}px` };
  const onTree = (show: boolean) => (compact ? setOverlayFor(show ? selection.path : null) : useFileExplorer.getState().setVisible(show));
  const root = "file" in buffer.view ? buffer.view.file.root : directory;
  useEffect(() => {
    if (!frame.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setCompact(entry.contentRect.width < 580);
    });
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => void flushDrafts(), []);
  return (
    <section
      ref={frame}
      aria-label="File"
      className="file-workspace"
      data-compact={compact || undefined}
      data-explorer={(treeVisible && !compact) || undefined}
      style={explorerStyle}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !compact || !treeVisible || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        onTree(false);
        requestAnimationFrame(() => frame.current?.querySelector<HTMLButtonElement>('[aria-label="Show file explorer"]')?.focus());
      }}
    >
      <FileToolbar
        selection={selection}
        buffer={buffer}
        directory={root}
        view={view}
        markdown={markdown}
        onView={(next) => choose({ selection, view: next })}
        treeVisible={treeVisible}
        onTree={onTree}
      />
      <div className="file-editor">
        <FileNotices buffer={buffer} name={fileName(selection.path)} />
        <FileBody buffer={buffer} selection={selection} preview={markdown && view === "preview"} />
      </div>
      {treeVisible ? (
        <>
          {compact ? <button className="file-explorer-backdrop" aria-label="Dismiss file explorer" onClick={() => onTree(false)} /> : <ExplorerResizeHandle />}
          <aside className="file-explorer-sidebar">
            <FileExplorer scope={selection.scope} directory={root} selected={selection.path} />
          </aside>
        </>
      ) : null}
    </section>
  );
}

/** What the user must know or decide before saving, one quiet line each. */
function FileNotices({ buffer, name }: { buffer: FileBuffer; name: string }) {
  const storageFailed = useDrafts((state) => state.failed);
  return (
    <>
      {buffer.view.kind === "conflict" ? (
        <div role="status" className="shrink-0 flex flex-wrap items-center gap-2 px-3 pt-2 text-sm text-ink-2">
          <span className="min-w-0 flex-1">{name} changed after you started editing.</span>
          <Button size="sm" onClick={buffer.keepMine}>
            Keep mine
          </Button>
          <Button size="sm" onClick={buffer.discard}>
            Use new version
          </Button>
        </div>
      ) : null}
      {buffer.view.kind === "deleted" ? (
        <div role="status" className="shrink-0 flex flex-wrap items-center gap-2 px-3 pt-2 text-sm text-ink-2">
          <span className="min-w-0 flex-1">{name} was deleted. Save to create it again.</span>
          <Button size="sm" onClick={buffer.discard}>
            Discard
          </Button>
        </div>
      ) : null}
      {buffer.error ? (
        <p role="alert" className="shrink-0 px-3 pt-2 text-sm text-bad">
          {buffer.error}
        </p>
      ) : null}
      {buffer.note ? (
        <p role="status" className="shrink-0 px-3 pt-2 text-sm text-ink-3">
          {buffer.note}
        </p>
      ) : null}
      {storageFailed && hasUnsavedEdits(buffer.view) ? (
        <p role="status" className="shrink-0 px-3 pt-2 text-sm text-warn">
          Unsaved changes can’t be kept on this device right now. Save to keep them.
        </p>
      ) : null}
    </>
  );
}

function status(text: string): ReactNode {
  return (
    <p role="status" className="p-4 text-sm text-ink-3">
      {text}
    </p>
  );
}

function FileBody({ buffer, selection, preview }: { buffer: FileBuffer; selection: FileSelection; preview: boolean }) {
  const { view, read } = buffer;
  if (read.error && view.kind === "loading") {
    return (
      <div role="status" className="p-4 text-sm text-ink-3">
        <p>{read.error.message}</p>
        <Button className="mt-3" size="sm" onClick={read.refresh}>
          Retry
        </Button>
      </div>
    );
  }
  if (view.kind === "loading" || buffer.key === null) return status("Loading file…");
  if (view.kind === "missing") return status("File not found. It may have moved or been deleted.");
  if (view.kind === "unreadable") return status(view.reason);
  const text = buffer.text ?? "";
  if (preview && view.kind !== "deleted") return <MarkdownPreview content={text} path={view.file.absolutePath} scope={selection.scope} />;
  return <SourceEditor buffer={buffer} sessionKey={buffer.key} selection={selection} text={text} path={view.kind === "deleted" ? view.path : view.file.path} />;
}

interface SourceEditorProps {
  buffer: FileBuffer;
  sessionKey: string;
  selection: FileSelection;
  text: string;
  path: string;
}

function SourceEditor({ buffer, sessionKey, selection, text, path }: SourceEditorProps) {
  const lines = useMemo(() => Math.max(1, text.split("\n").length - (text.endsWith("\n") ? 1 : 0)), [text]);
  return (
    <>
      {selection.line && selection.line > lines ? status(`Line ${selection.line} is past the end of this file. Showing line ${lines}.`) : null}
      <div className="flex-1 min-h-0" onBlur={() => void flushDrafts()}>
        <Suspense fallback={status("Loading editor…")}>
          <CodeEditor
            key={sessionKey}
            sessionKey={sessionKey}
            path={path}
            text={text}
            readOnly={buffer.readOnly !== null}
            reveal={revealOf(selection)}
            focusRequest={buffer.focusRequest}
            onChange={buffer.edit}
            onSave={buffer.save}
            onFormat={buffer.format}
          />
        </Suspense>
      </div>
    </>
  );
}

/** Rendered like a reply, with relative links and images resolved from the document's own folder. */
function MarkdownPreview({ content, path, scope }: { content: string; path: string; scope: FileSelection["scope"] }) {
  return (
    <ThreadMedia scopeKey={path} basePath={path.replace(/[\\/][^\\/]*$/, "")} fileScope={scope}>
      <div className="flex-1 min-h-0 overflow-auto px-5 py-4 text-prose text-ink prose-chat">
        {content ? <ThreadRichText mode="static">{content}</ThreadRichText> : <p className="text-sm text-ink-3">This file is empty.</p>}
      </div>
    </ThreadMedia>
  );
}
