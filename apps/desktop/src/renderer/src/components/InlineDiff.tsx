import { useEffect, useMemo, useRef } from "react";
import { parsePatchFiles, type CodeViewItem } from "@pierre/diffs";
import { CodeView, WorkerPoolContextProvider, type CodeViewHandle } from "@pierre/diffs/react";
import DiffWorker from "@pierre/diffs/worker/worker.js?worker";
import { useTheme } from "../lib/theme";
import { applyDiffIcons } from "./icons-diff";

const workerFactory = () => new DiffWorker();

/** A read-only diff within a chat row. Long patches scroll inside the row. */
export function InlineDiff({ patch }: { patch: string }) {
  const viewer = useRef<CodeViewHandle<undefined, undefined>>(null);
  const theme = useTheme((s) => s.resolved);
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
  useEffect(() => {
    viewer.current?.scrollTo({ type: "position", position: 0, behavior: "instant" });
  }, [preview]);
  if (!preview)
    return (
      <div className="my-2 text-xs text-ink-3">
        <p role="status">Diff preview unavailable. The patch may be incomplete.</p>
        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre font-mono rounded-lg border border-line p-3">{patch}</pre>
      </div>
    );
  return (
    <section aria-label="Inline diff" className="my-2 min-w-0 overflow-hidden rounded-lg border border-line" style={{ height: preview.height, maxHeight: "55vh" }}>
      <WorkerPoolContextProvider
        poolOptions={{ workerFactory, poolSize: 2 }}
        highlighterOptions={{ theme: { light: "github-light", dark: "github-dark" }, langs: ["ts", "tsx", "js", "jsx", "json", "css", "html", "md", "yaml", "sh", "py", "rs", "go"] }}
      >
        <CodeView
          key={patch}
          ref={viewer}
          className="diffscroll h-full overflow-auto"
          items={preview.items}
          options={{ diffStyle: "unified", theme: { light: "github-light", dark: "github-dark" }, themeType: theme, enableLineSelection: false, onPostRender: applyDiffIcons }}
        />
      </WorkerPoolContextProvider>
    </section>
  );
}
