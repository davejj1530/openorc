import { useMemo, useState } from "react";
import { joinPath, printedOutput, type PrintedLine } from "@openorc/client";
import { X } from "./icons";
import { ThreadLink, ThreadRichText } from "./ThreadImages";

/** Lines shown before a long output folds; a fold that would hide only a few lines shows them instead. */
const LINES = 14;
const SLACK = 4;

/**
 * What a command printed, read rather than dumped: dividers as quiet headings, failures and warnings in their tone,
 * a file named at the start of a line as a link to it. A long output shows its first lines and fades. `cwd` is the
 * folder the command ran in, which the paths it printed are relative to.
 */
export function PrintedText({ text, cwd }: { text: string; cwd: string | null }) {
  const { exit, lines } = useMemo(() => printedOutput(text), [text]);
  const [all, setAll] = useState(false);
  const folds = lines.length > LINES + SLACK;
  const shown = folds && !all ? lines.slice(0, LINES) : lines;
  return (
    <div className="tool-view-output">
      {exit !== null ? (
        <span className="tool-view-exit">
          <X size={12} /> Exit code {exit}
        </span>
      ) : null}
      {lines.length ? (
        <div className="tool-view-printed">
          <div className="tool-view-printed-lines" data-folded={(folds && !all) || undefined}>
            {shown.map((line, index) => (
              <Line key={index} line={line} cwd={cwd} />
            ))}
          </div>
        </div>
      ) : null}
      {!lines.length && exit === null ? <span className="tool-view-quiet">No output</span> : null}
      {folds ? (
        <button type="button" className="tool-view-more" aria-expanded={all} onClick={() => setAll((value) => !value)}>
          {all ? "Show less" : `Show all ${lines.length} lines`}
        </button>
      ) : null}
    </div>
  );
}

function Line({ line, cwd }: { line: PrintedLine; cwd: string | null }) {
  if (line.kind === "rule") return <div className="tool-view-rule">{line.text ? <span>{line.text}</span> : null}</div>;
  const { text, ref, tone } = line;
  if (!ref) return <div data-tone={tone ?? undefined}>{text}</div>;
  const href = joinPath(cwd, ref.path) + (ref.line === null ? "" : `:${ref.line}`);
  return (
    <div data-tone={tone ?? undefined}>
      {text.slice(0, ref.start)}
      <ThreadLink href={href}>{text.slice(ref.start, ref.end)}</ThreadLink>
      {text.slice(ref.end)}
    </div>
  );
}

/** Fenced so it renders as code in replies does: highlighted, numbered from where the excerpt starts. */
function fence(code: string, language: string, startLine: number | null): string {
  const longest = (code.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 2);
  const ticks = "`".repeat(longest + 1);
  const meta = startLine && startLine > 1 ? ` startLine=${startLine}` : "";
  return `${ticks}${language}${meta}\n${code}\n${ticks}`;
}

/** Highlighted code. A `script` is the body a command step feeds in, set inside the command rather than apart. */
export function Code({ code, language, startLine, script }: { code: string; language: string; startLine: number | null; script?: boolean }) {
  const markdown = useMemo(() => fence(code, language, startLine), [code, language, startLine]);
  return (
    <div className="tool-view-code" data-script={script || undefined}>
      <ThreadRichText lineNumbers={startLine !== null}>{markdown}</ThreadRichText>
    </div>
  );
}
