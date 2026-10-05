import { useEffect, useMemo, useRef } from "react";
import { parseDiffFromFile, parsePatchFiles, type CodeViewItem } from "@pierre/diffs";
import { CodeView, WorkerPoolContextProvider, type CodeViewHandle } from "@pierre/diffs/react";
import DiffWorker from "@pierre/diffs/worker/worker.js?worker";
import { useTheme } from "../lib/theme";
import { applyDiffIcons } from "./icons-diff";

const workerFactory = () => new DiffWorker();

/** The shared read-only diff viewer for chat rows. Long diffs scroll inside the row. */
function DiffItems({ items, height, label, lineNumbers = true }: { items: CodeViewItem<undefined>[]; height: number; label: string; lineNumbers?: boolean }) {
  const viewer = useRef<CodeViewHandle<undefined, undefined>>(null);
  const theme = useTheme((s) => s.resolved);
  useEffect(() => {
    viewer.current?.scrollTo({ type: "position", position: 0, behavior: "instant" });
  }, [items]);
  return (
    <section aria-label={label} className="my-2 min-w-0 overflow-hidden rounded-lg border border-line" style={{ height, maxHeight: "55vh" }}>
      <WorkerPoolContextProvider
        poolOptions={{ workerFactory, poolSize: 2 }}
        highlighterOptions={{ theme: { light: "github-light", dark: "github-dark" }, langs: ["ts", "tsx", "js", "jsx", "json", "css", "html", "md", "yaml", "sh", "py", "rs", "go"] }}
      >
        <CodeView
          ref={viewer}
          className="diffscroll h-full overflow-auto"
          items={items}
          options={{
            diffStyle: "unified",
            theme: { light: "github-light", dark: "github-dark" },
            themeType: theme,
            enableLineSelection: false,
            disableLineNumbers: !lineNumbers,
            onPostRender: applyDiffIcons,
          }}
        />
      </WorkerPoolContextProvider>
    </section>
  );
}

/** A read-only diff within a chat row, from a unified patch. */
export function InlineDiff({ patch }: { patch: string }) {
  const preview = useMemo(() => {
    try {
      if (patch.split("\n").some((line) => line.startsWith("@@") && !/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line))) return null;
      const files = parsePatchFiles(patch, undefined, true).flatMap((part) => part.files);
      if (!files.length) return null;
      const height = files.reduce((sum, file) => sum + 48 + file.unifiedLineCount * 20 + file.hunks.length * 28, 0);
      const items: CodeViewItem<undefined>[] = files.map((fileDiff, index) => ({ id: `${index}:${fileDiff.name}`, type: "diff", fileDiff }));
      return { items, height: Math.min(420, Math.max(96, height)) };
    } catch {
      return null;
    }
  }, [patch]);
  if (!preview)
    return (
      <div className="my-2 text-xs text-ink-3">
        <p role="status">Diff preview unavailable. The patch may be incomplete.</p>
        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre font-mono rounded-lg border border-line p-3">{patch}</pre>
      </div>
    );
  return <DiffItems key={patch} items={preview.items} height={preview.height} label="Inline diff" />;
}

/**
 * An edit as the text it replaced and the text it wrote. Without the file around it the line numbers would be the
 * snippet's own, so they stay hidden.
 */
export function EditDiff({ path, before, after }: { path: string; before: string; after: string }) {
  const items = useMemo<CodeViewItem<undefined>[] | null>(() => {
    try {
      const name = path || "edit";
      // Snippets end where the edit ends, not at the end of a file, so neither side is "missing" its last newline.
      const line = (text: string) => (text.endsWith("\n") ? text : `${text}\n`);
      return [{ id: `edit:${name}`, type: "diff", fileDiff: parseDiffFromFile({ name, contents: line(before) }, { name, contents: line(after) }) }];
    } catch {
      return null;
    }
  }, [path, before, after]);
  if (!items) return <pre className="my-2 max-h-72 overflow-auto whitespace-pre-wrap font-mono text-xs rounded-lg border border-line p-3">{after}</pre>;
  const lines = before.split("\n").length + after.split("\n").length;
  return <DiffItems key={`${path}\n${before}\n${after}`} items={items} height={Math.min(420, Math.max(96, 48 + lines * 20))} label="Edit" lineNumbers={false} />;
}
