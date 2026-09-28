import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CodeView, WorkerPoolContextProvider, type CodeViewHandle } from "@pierre/diffs/react";
import type { CodeViewItem } from "@pierre/diffs";
import DiffWorker from "@pierre/diffs/worker/worker.js?worker";
import { useRpc } from "../lib/query";
import { useTheme } from "../lib/theme";
import type { FileSelection } from "../lib/layout";
import { Button, Segmented } from "../components/ui";
import { applyDiffIcons } from "../components/icons-diff";
import { ThreadMedia, ThreadRichText } from "../components/ThreadImages";

const workerFactory = () => new DiffWorker();

type View = "preview" | "source";
const views: { value: View; label: string }[] = [
  { value: "preview", label: "Preview" },
  { value: "source", label: "Source" },
];
const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);

/** The citation's current on-disk source, read from its thread or task workspace. */
export function FilePanel({ selection }: { selection: FileSelection }) {
  const file = useRpc("files.read", { scope: selection.scope, path: selection.path });
  const name = selection.path.split(/[\\/]/).pop() ?? selection.path;
  const markdown = isMarkdown(selection.path);
  // A cited line opens the source there; a plain link to a Markdown file opens it rendered.
  const [chosen, choose] = useState<{ selection: FileSelection; view: View } | null>(null);
  let view: View = selection.line ? "source" : "preview";
  if (chosen?.selection === selection) view = chosen.view;
  let content: ReactNode = null;
  if (file.isLoading) {
    content = (
      <p role="status" className="p-4 text-sm text-ink-3">
        Loading file…
      </p>
    );
  } else if (file.error) {
    content = (
      <div role="status" className="p-4 text-sm text-ink-3">
        <p>{file.error.message}</p>
        <Button className="mt-3" size="sm" onClick={() => void file.refetch()}>
          Retry
        </Button>
      </div>
    );
  } else if (file.data) {
    content =
      markdown && view === "preview" ? <MarkdownPreview content={file.data.content} path={file.data.path} scope={selection.scope} /> : <SourceCode content={file.data.content} selection={selection} />;
  }
  return (
    <section aria-label="Code preview" className="h-full min-h-0 flex flex-col">
      <header className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-line">
        <div className="min-w-0 flex-1" title={selection.path}>
          <div className="truncate text-base font-medium">
            {name}
            {selection.line ? `:${selection.line}${selection.endLine ? `–${selection.endLine}` : ""}` : ""}
          </div>
          <div className="truncate text-xs text-ink-3">{selection.path}</div>
        </div>
        {markdown ? <Segmented size="sm" label="File view" value={view} onChange={(next) => choose({ selection, view: next })} options={views} /> : null}
        <Button size="sm" variant="ghost" disabled={file.isFetching} onClick={() => void file.refetch()}>
          Refresh
        </Button>
      </header>
      {content}
    </section>
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

function SourceCode({ content, selection }: { content: string; selection: FileSelection }) {
  const viewer = useRef<CodeViewHandle<undefined, undefined>>(null);
  const theme = useTheme((s) => s.resolved);
  const items = useMemo<CodeViewItem<undefined>[]>(() => [{ id: "source", type: "file", file: { name: selection.path, contents: content } }], [selection.path, content]);
  const count = useMemo(() => Math.max(1, content.split("\n").length - (content.endsWith("\n") ? 1 : 0)), [content]);
  const line = Math.min(selection.line ?? 1, count);
  const end = Math.min(selection.endLine ?? line, count);
  useEffect(() => {
    viewer.current?.scrollTo({ type: "line", id: "source", lineNumber: line, align: "center", behavior: "instant" });
  }, [selection, content, line]);
  return (
    <>
      {selection.line && selection.line > count ? (
        <p role="status" className="shrink-0 px-3 py-2 text-xs text-ink-3">
          Line {selection.line} is past the end of this file. Showing line {count}.
        </p>
      ) : null}
      {!content ? (
        <p className="p-4 text-sm text-ink-3">This file is empty.</p>
      ) : (
        <WorkerPoolContextProvider
          poolOptions={{ workerFactory, poolSize: 2 }}
          highlighterOptions={{ theme: { light: "github-light", dark: "github-dark" }, langs: ["ts", "tsx", "js", "jsx", "json", "css", "html", "md", "yaml", "sh", "py", "rs", "go"] }}
        >
          <CodeView
            ref={viewer}
            className="diffscroll flex-1 min-h-0 overflow-auto"
            items={items}
            selectedLines={selection.line ? { id: "source", range: { start: line, end } } : null}
            options={{ theme: { light: "github-light", dark: "github-dark" }, themeType: theme, disableFileHeader: true, enableLineSelection: false, onPostRender: applyDiffIcons }}
          />
        </WorkerPoolContextProvider>
      )}
    </>
  );
}
