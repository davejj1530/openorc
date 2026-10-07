import { Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { CodeEditor, type LineRange } from "../components/code-editor";
import { Button, Segmented, Tooltip } from "../components/ui";
import { ThreadMedia, ThreadRichText } from "../components/ThreadImages";
import { hasUnsavedEdits } from "../lib/file-buffer";
import { flushDrafts, useDrafts } from "../lib/file-drafts";
import type { FileSelection } from "../lib/layout";
import { useFileBuffer, type FileBuffer } from "../lib/use-file-buffer";

type View = "preview" | "source";
const views: { value: View; label: string }[] = [
  { value: "preview", label: "Preview" },
  { value: "source", label: "Source" },
];
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
export function FilePanel({ selection }: { selection: FileSelection }) {
  const buffer = useFileBuffer(selection);
  const markdown = isMarkdown(selection.path);
  const [chosen, choose] = useState<{ selection: FileSelection; view: View } | null>(null);
  let view: View = selection.line ? "source" : "preview";
  if (chosen?.selection === selection) view = chosen.view;
  useEffect(() => () => void flushDrafts(), []);
  return (
    <section aria-label="File" className="h-full min-h-0 flex flex-col">
      <header className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-line">
        <div className="min-w-0 flex-1" title={selection.path}>
          <div className="truncate text-base font-medium">
            {fileName(selection.path)}
            {selection.line ? `:${selection.line}${selection.endLine ? `–${selection.endLine}` : ""}` : ""}
          </div>
          <div className="truncate text-xs text-ink-3">{selection.path}</div>
        </div>
        {buffer.readOnly ? (
          <Tooltip label={buffer.readOnly}>
            <span tabIndex={0} className="text-sm text-ink-3">
              Read-only
            </span>
          </Tooltip>
        ) : null}
        {markdown ? <Segmented size="sm" label="File view" value={view} onChange={(next) => choose({ selection, view: next })} options={views} /> : null}
        <Button size="sm" variant="ghost" disabled={buffer.read.refreshing} onClick={buffer.read.refresh}>
          Refresh
        </Button>
        {hasUnsavedEdits(buffer.view) || buffer.saving ? (
          <Button size="sm" disabled={buffer.saving || buffer.view.kind === "conflict"} onClick={buffer.save}>
            {buffer.saving ? "Saving…" : "Save"}
          </Button>
        ) : null}
      </header>
      <FileNotices buffer={buffer} name={fileName(selection.path)} />
      <FileBody buffer={buffer} selection={selection} preview={markdown && view === "preview"} />
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
