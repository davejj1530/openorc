import { Suspense } from "react";
import type { CodeExplanation, CodeUsage, FileScope, LineSpan, WalkthroughBlock } from "@openorc/protocol";
import { CodeExcerpt } from "../../components/code-editor";
import { RichText } from "../../components/RichText";
import { Tooltip } from "../../components/ui";
import { useLayout } from "../../lib/layout";
import { useWordWrap } from "../../lib/word-wrap";
import { walkthroughSegments } from "./walkthrough-segments";

type Walkthrough = Extract<CodeExplanation, { view: "walkthrough" }>;

export const spanLabel = ({ start, end }: LineSpan) => (start === end ? `Line ${start}` : `Lines ${start}–${end}`);

function Excerpt({ text, path, start, end }: { text: string; path: string; start: number; end: number }) {
  const wrap = useWordWrap((state) => state.wrap);
  return (
    <Suspense fallback={<pre className="code-excerpt" style={{ minHeight: (end - start + 1) * 20 + 16 }} />}>
      <CodeExcerpt text={text} path={path} start={start} end={end} wrap={wrap} />
    </Suspense>
  );
}

/** A file that uses the block, opened at the line that names it. */
function Usage({ usage, scope }: { usage: CodeUsage; scope: FileScope }) {
  const cut = usage.path.lastIndexOf("/");
  return (
    <Tooltip label={usage.text}>
      <button type="button" className="explain-usage" aria-label={`${usage.path}:${usage.line}`} onClick={() => useLayout.getState().openFile({ path: usage.path, scope, line: usage.line })}>
        {cut > 0 ? <span className="explain-usage-folder">{usage.path.slice(0, cut + 1)}</span> : null}
        {usage.path.slice(cut + 1)}:{usage.line}
      </button>
    </Tooltip>
  );
}

function Block({ block, text, path, scope, onShowLines }: { block: WalkthroughBlock; text: string; path: string; scope: FileScope; onShowLines: (lines: LineSpan) => void }) {
  return (
    <section className="explain-block" aria-label={block.title}>
      <header className="explain-block-head">
        <h3>{block.title}</h3>
        <Tooltip label="Show in the code">
          <button type="button" className="explain-block-lines" onClick={() => onShowLines(block.lines)}>
            {spanLabel(block.lines)}
          </button>
        </Tooltip>
      </header>
      {block.explanation ? (
        <div className="explain-block-text prose-chat">
          <RichText mode="static">{block.explanation}</RichText>
        </div>
      ) : null}
      {block.usedBy.length ? (
        <div className="explain-block-used" role="group" aria-label="Used by">
          <span>Used by</span>
          {block.usedBy.map((usage) => (
            <Usage key={usage.path} usage={usage} scope={scope} />
          ))}
        </div>
      ) : null}
      <div className="explain-block-code">
        <Excerpt text={text} path={path} start={block.lines.start} end={block.lines.end} />
      </div>
    </section>
  );
}

/** The file read top to bottom: each part framed with what it does and who uses it, the code between parts as it is. */
export function WalkthroughView({ explanation, text, path, scope, onShowLines }: { explanation: Walkthrough; text: string; path: string; scope: FileScope; onShowLines: (lines: LineSpan) => void }) {
  const source = text.replace(/\r\n/g, "\n");
  const segments = walkthroughSegments(explanation.blocks, source.replace(/\n$/, "").split("\n"));
  return (
    <div className="explain-scroll">
      <div className="explain-walkthrough">
        {explanation.overview ? <p className="explain-overview">{explanation.overview}</p> : null}
        {segments.map((segment) =>
          segment.kind === "block" ? (
            <Block key={`block:${segment.block.lines.start}`} block={segment.block} text={source} path={path} scope={scope} onShowLines={onShowLines} />
          ) : (
            <div key={`code:${segment.start}`} className="explain-between">
              <Excerpt text={source} path={path} start={segment.start} end={segment.end} />
            </div>
          ),
        )}
      </div>
    </div>
  );
}
