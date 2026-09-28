import { Component, memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { Streamdown, type DiagramPlugin, type IconMap, type StreamdownProps } from "streamdown";
import { createCodePlugin } from "@streamdown/code";
import { math } from "@streamdown/math";
import { Check, Copy, Download, ExternalLink, Loader2, Maximize2, RotateCcw, X, ZoomIn, ZoomOut } from "./icons";

const icons = {
  CheckIcon: Check,
  CopyIcon: Copy,
  DownloadIcon: Download,
  ExternalLinkIcon: ExternalLink,
  Loader2Icon: Loader2,
  Maximize2Icon: Maximize2,
  RotateCcwIcon: RotateCcw,
  XIcon: X,
  ZoomInIcon: ZoomIn,
  ZoomOutIcon: ZoomOut,
} satisfies IconMap;

const code = createCodePlugin({ themes: ["github-light-default", "github-dark-default"] });
let diagrams: Promise<DiagramPlugin> | undefined;
function loadDiagrams() {
  return (diagrams ??= import("@streamdown/mermaid")
    .then(({ createMermaidPlugin }) => createMermaidPlugin({ config: { securityLevel: "strict", startOnLoad: false } }))
    .catch((error) => {
      diagrams = undefined;
      throw error;
    }));
}
const controls = { code: { copy: true, download: true }, table: { copy: true, download: true, fullscreen: true }, mermaid: { copy: true, download: true, fullscreen: true } };
// Main validates destinations and routes links into the sandboxed sidebar.
const linkSafety = { enabled: false };

/** A missing lazy formatter must never take the conversation and composer with it. */
class FormattingBoundary extends Component<{ text: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div>
        <p className="mb-2 text-sm" role="status">
          Formatting unavailable. Showing the original message.
        </p>
        <div className="whitespace-pre-wrap break-words">{this.props.text}</div>
      </div>
    );
  }
}

/** One streaming-safe renderer for replies, task reports, and document previews. */
export const RichText = memo(function RichText({ children, ...props }: StreamdownProps) {
  const hasDiagram = /(?:^|\n)\s*(?:`{3,}|~{3,})mermaid\b/.test(children ?? "");
  const [mermaid, setMermaid] = useState<DiagramPlugin>();
  const [diagramError, setDiagramError] = useState(false);
  useEffect(() => {
    if (!hasDiagram || mermaid) return;
    let active = true;
    loadDiagrams()
      .then((plugin) => {
        if (active) setMermaid(plugin);
      })
      .catch(() => {
        if (active) setDiagramError(true);
      });
    return () => {
      active = false;
    };
  }, [hasDiagram, mermaid]);
  const plugins = useMemo(() => ({ code, math, mermaid }), [mermaid]);
  return (
    <FormattingBoundary text={children ?? ""}>
      <Streamdown plugins={plugins} controls={controls} linkSafety={linkSafety} lineNumbers={false} codeBlockMaxHeight="480px" tableMaxHeight="480px" {...props} icons={icons}>
        {children}
      </Streamdown>
      {diagramError && hasDiagram && (
        <p className="text-sm text-ink-3" role="status">
          The diagram renderer could not load. Its source is shown above.
        </p>
      )}
    </FormattingBoundary>
  );
});
