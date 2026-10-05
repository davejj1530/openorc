import { lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import { toolResult, toolResultDetails } from "../lib/tool-result";
import { languageFor, type ChangedFile, type ChangeStatus, type MatchGroup, type MatchLine, type TestTally } from "../lib/tool-text";
import { joinPath, toolInputView, toolOutputView, type CommandStep, type Field, type InputView, type OutputView } from "../lib/tool-view";
import type { Block } from "../lib/transcript";
import { FileGlyph } from "./FileGlyph";
import { Check, Globe, Search, WorkDelegate, X } from "./icons";
import { ThreadLink, ThreadRichText } from "./ThreadImages";
import { ToolResult } from "./ToolResult";
import "./ToolDetail.css";

const InlineDiff = lazy(() => import("./InlineDiff").then((m) => ({ default: m.InlineDiff })));
const EditDiff = lazy(() => import("./InlineDiff").then((m) => ({ default: m.EditDiff })));

type ToolBlock = Extract<Block, { kind: "tool" }>;

const loading = (
  <p role="status" className="text-xs text-ink-3">
    Loading diff…
  </p>
);

/**
 * A tool call opened: what it was asked, in the form that suits it, and what came back the same way. A command
 * reads as its steps, a printed file as highlighted code, a search as its matches, a test run as its tally. The raw
 * call stays one click away.
 */
export function ToolDetail({ block, output }: { block: ToolBlock; output: unknown }) {
  const input = useMemo(() => toolInputView(block), [block]);
  const result = useMemo(() => (output === undefined ? null : toolResult(output)), [output]);
  // A successful edit's diff says what happened; "The file has been updated" adds nothing. A failed one says why.
  const quiet = !block.isError && (input.kind === "edit" || input.kind === "write" || input.kind === "patch");
  const view = useMemo(() => (result && !result.media.length && !quiet ? toolOutputView(block, result.text) : null), [block, result, quiet]);
  const [raw, setRaw] = useState(false);
  return (
    <div className="tool-view" data-error={block.isError || undefined}>
      <InputPart view={input} />
      {result?.media.length ? <ToolResult output={output} /> : null}
      {view ? <OutputPart view={view} cwd={input.kind === "command" ? input.cwd : null} /> : null}
      <button type="button" className="tool-view-more" aria-expanded={raw} onClick={() => setRaw((value) => !value)}>
        {raw ? "Hide raw call" : "Raw call"}
      </button>
      {raw ? <RawCall input={block.input} output={output} /> : null}
    </div>
  );
}

function InputPart({ view }: { view: InputView }) {
  switch (view.kind) {
    case "command":
      return <CommandLine steps={view.steps} cwd={view.cwd} />;
    case "file":
      return <FileLine path={view.path} note={view.lines} />;
    case "patch":
      return (
        <Suspense fallback={loading}>
          <InlineDiff patch={view.patch} />
        </Suspense>
      );
    case "edit":
      return (
        <Suspense fallback={loading}>
          <EditDiff path={view.path} before={view.before} after={view.after} />
        </Suspense>
      );
    case "write":
      return <Code code={view.content} language={languageFor(view.path)} startLine={1} />;
    case "search":
      return <SearchLine pattern={view.pattern} scope={view.scope} flags={view.flags} />;
    case "web":
      return <WebLine target={view.target} />;
    case "prompt":
      return <Prompt text={view.text} agent={view.agent} />;
    case "fields":
      return <Fields fields={view.fields} />;
    case "none":
      return null;
  }
}

/** `cwd` is the folder the command ran in, which the paths it printed are relative to. */
function OutputPart({ view, cwd }: { view: OutputView; cwd: string | null }) {
  switch (view.kind) {
    case "code":
      return <Code code={view.code} language={view.language} startLine={view.startLine} />;
    case "matches":
      return <Matches groups={view.groups} pattern={view.pattern} cwd={cwd} />;
    case "files":
      return <FileList items={view.paths.map((path) => ({ path }))} cwd={cwd} />;
    case "changes":
      return <FileList items={view.files.map(changeItem)} cwd={cwd} />;
    case "diff":
      return (
        <Suspense fallback={loading}>
          <InlineDiff patch={view.patch} />
        </Suspense>
      );
    case "tests":
      return <Tests tally={view.tally} text={view.text} />;
    case "json":
      return <Code code={view.json} language="json" startLine={null} />;
    case "markdown":
      return (
        <div className="tool-view-prose prose-chat">
          <ThreadRichText>{view.text}</ThreadRichText>
        </div>
      );
    case "text":
      return <pre className="tool-view-plain">{view.text}</pre>;
  }
}

/** "…/renderer/src": enough of a folder to place it. */
function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

/** A path with its folder quiet and its name plain. */
function PathText({ path }: { path: string }) {
  const cut = path.replace(/[\\/]$/, "").search(/[^\\/]*$/);
  return (
    <>
      <span className="tool-view-dir">{path.slice(0, cut)}</span>
      {path.slice(cut)}
    </>
  );
}

const COMMAND_LINES = 12;

const lineCount = (text: string) => text.split("\n").length;

/** The first `budget` lines of a command: each step's line, then its script, until the budget runs out. */
function firstLines(steps: CommandStep[], budget: number): CommandStep[] {
  const shown: CommandStep[] = [];
  let left = budget;
  for (const step of steps) {
    if (left <= 0) break;
    const text = step.text.split("\n").slice(0, left);
    left -= text.length;
    const code = step.body && left > 0 ? step.body.code.split("\n").slice(0, left) : [];
    left -= code.length;
    shown.push({ text: text.join("\n"), body: step.body && code.length ? { ...step.body, code: code.join("\n") } : null });
  }
  return shown;
}

/** A command as a terminal would show it: the folder, then each step at its prompt with the script it feeds in. */
function CommandLine({ steps, cwd }: { steps: CommandStep[]; cwd: string | null }) {
  const [all, setAll] = useState(false);
  const total = useMemo(() => steps.reduce((sum, step) => sum + lineCount(step.text) + (step.body ? lineCount(step.body.code) : 0), 0), [steps]);
  const shown = all || total <= COMMAND_LINES ? steps : firstLines(steps, COMMAND_LINES);
  return (
    <div className="tool-view-command">
      {cwd ? (
        <span className="tool-view-cwd" title={cwd}>
          {shortPath(cwd)}
        </span>
      ) : null}
      {shown.map((step, index) => (
        <Step key={index} step={step} />
      ))}
      {total > COMMAND_LINES ? (
        <button type="button" className="tool-view-more" aria-expanded={all} onClick={() => setAll((value) => !value)}>
          {all ? "Show less" : `Show all ${total} lines`}
        </button>
      ) : null}
    </div>
  );
}

function Step({ step }: { step: CommandStep }) {
  const comment = step.text.startsWith("#");
  return (
    <div className="tool-view-step">
      <code data-comment={comment || undefined}>
        {comment ? null : (
          <span className="tool-view-prompt" aria-hidden="true">
            $
          </span>
        )}
        {step.text}
      </code>
      {step.body ? <Code code={step.body.code} language={step.body.language} startLine={null} script /> : null}
    </div>
  );
}

/** A file as a row: its mark, its path as a link that opens it, and a note after. */
function FileLine({ path, href = path, note, linked = true }: { path: string; href?: string; note?: ReactNode; linked?: boolean }) {
  return (
    <div className="tool-view-target">
      <FileGlyph path={path} />
      <span className="tool-view-link" title={href}>
        {linked ? (
          <ThreadLink href={href}>
            <PathText path={path} />
          </ThreadLink>
        ) : (
          <PathText path={path} />
        )}
      </span>
      {note ? <span className="tool-view-note">{note}</span> : null}
    </div>
  );
}

function SearchLine({ pattern, scope, flags }: { pattern: string; scope: string | null; flags: string[] }) {
  return (
    <div className="tool-view-target">
      <Search size={12} className="tool-view-icon" />
      <code className="tool-view-pattern">{pattern}</code>
      {scope ? (
        <span className="tool-view-note" title={scope}>
          in {shortPath(scope)}
        </span>
      ) : null}
      {flags.map((flag) => (
        <span key={flag} className="tool-view-flag">
          {flag}
        </span>
      ))}
    </div>
  );
}

function WebLine({ target }: { target: string }) {
  return (
    <div className="tool-view-target">
      <Globe size={12} className="tool-view-icon" />
      <span className="tool-view-link" title={target}>
        {/^https?:\/\//.test(target) ? <ThreadLink href={target}>{target}</ThreadLink> : target}
      </span>
    </div>
  );
}

function Prompt({ text, agent }: { text: string; agent: string | null }) {
  return (
    <div className="tool-view-brief">
      {agent ? (
        <span className="tool-view-flag">
          <WorkDelegate size={12} /> {agent}
        </span>
      ) : null}
      <div className="tool-view-prose prose-chat">
        <ThreadRichText>{text}</ThreadRichText>
      </div>
    </div>
  );
}

function Fields({ fields }: { fields: Field[] }) {
  return (
    <dl className="tool-view-fields">
      {fields.map((field) => (
        <div key={field.key}>
          <dt>{field.key}</dt>
          <dd>{field.structured ? <pre>{field.value}</pre> : field.value}</dd>
        </div>
      ))}
    </dl>
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
function Code({ code, language, startLine, script }: { code: string; language: string; startLine: number | null; script?: boolean }) {
  const markdown = useMemo(() => fence(code, language, startLine), [code, language, startLine]);
  return (
    <div className="tool-view-code" data-script={script || undefined}>
      <ThreadRichText lineNumbers={startLine !== null}>{markdown}</ThreadRichText>
    </div>
  );
}

/** The search pattern as a highlighter, literal when it is not a valid expression here. */
function highlighter(pattern: string | null): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(`(${pattern})`, "gi");
  } catch {
    return new RegExp(`(${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  }
}

function marked(text: string, pattern: RegExp | null): ReactNode {
  if (!pattern) return text;
  return text.split(pattern).map((part, index) => (index % 2 ? <mark key={index}>{part}</mark> : part));
}

const MATCH_FILES = 6;
const MATCH_LINES = 5;

const matchCount = (group: MatchGroup) => group.lines.filter((line) => !line.context).length;

/** A group's lines up to its `count`th match, with the context printed around those matches. */
function firstMatches(lines: MatchLine[], count: number): MatchLine[] {
  const shown: MatchLine[] = [];
  let matches = 0;
  for (const line of lines) {
    if (!line.context && ++matches > count) break;
    shown.push(line);
  }
  return shown;
}

function Matches({ groups, pattern, cwd }: { groups: MatchGroup[]; pattern: string | null; cwd: string | null }) {
  const [all, setAll] = useState(false);
  const highlight = useMemo(() => highlighter(pattern), [pattern]);
  const total = groups.reduce((sum, group) => sum + matchCount(group), 0);
  const shown = all ? groups : groups.slice(0, MATCH_FILES);
  const hidden = total - shown.reduce((sum, group) => sum + Math.min(matchCount(group), MATCH_LINES), 0);
  return (
    <div className="tool-view-matches">
      {shown.map((group) => {
        const href = joinPath(cwd, group.path);
        return (
          <section key={group.path}>
            <FileLine path={group.path} href={href} note={matchCount(group)} />
            <ol>
              {(all ? group.lines : firstMatches(group.lines, MATCH_LINES)).map((line, index) => (
                <li key={index} title={line.text} data-context={line.context || undefined}>
                  <span className="tool-view-line">{line.line === null ? null : <ThreadLink href={`${href}:${line.line}`}>{line.line}</ThreadLink>}</span>
                  <code>{line.context ? line.text : marked(line.text, highlight)}</code>
                </li>
              ))}
            </ol>
          </section>
        );
      })}
      {!all && hidden > 0 ? (
        <button type="button" className="tool-view-more" onClick={() => setAll(true)}>
          Show all {total} matches
        </button>
      ) : null}
    </div>
  );
}

interface FileItem {
  path: string;
  note?: ReactNode;
  /** A deleted file has nothing left to open. */
  linked?: boolean;
}

const STATUS: Record<ChangeStatus, string> = {
  added: "Added",
  untracked: "New",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  conflict: "Conflict",
};

const changeItem = (file: ChangedFile): FileItem => ({
  path: file.path,
  linked: file.status !== "deleted",
  note: <span data-status={file.status}>{STATUS[file.status]}</span>,
});

const FILES_SHOWN = 12;

function FileList({ items, cwd }: { items: FileItem[]; cwd: string | null }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, FILES_SHOWN);
  return (
    <div className="tool-view-files">
      <ul>
        {shown.map((item) => (
          <li key={item.path}>
            <FileLine {...item} href={joinPath(cwd, item.path)} />
          </li>
        ))}
      </ul>
      {items.length > shown.length ? (
        <button type="button" className="tool-view-more" onClick={() => setAll(true)}>
          Show all {items.length} files
        </button>
      ) : null}
    </div>
  );
}

/** The tally first; the runner's output opens by itself only when something failed. */
function Tests({ tally, text }: { tally: TestTally; text: string }) {
  const [open, setOpen] = useState(tally.failed > 0);
  return (
    <div className="tool-view-tests">
      <div className="tool-view-tally">
        {tally.failed ? (
          <span data-tone="bad">
            <X size={12} /> {tally.failed} failed
          </span>
        ) : null}
        <span data-tone="ok">
          <Check size={12} /> {tally.passed} passed
        </span>
        {tally.skipped ? <span>{tally.skipped} skipped</span> : null}
        <button type="button" className="tool-view-more" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? "Hide output" : "Output"}
        </button>
      </div>
      {open ? <pre className="tool-view-plain">{text}</pre> : null}
    </div>
  );
}

function RawCall({ input, output }: { input: unknown; output: unknown }) {
  const text = useMemo(() => ({ input: JSON.stringify(input, null, 2) ?? "", output: output === undefined ? "" : toolResultDetails(output) }), [input, output]);
  return (
    <div className="tool-view-raw">
      <span className="tool-view-note">Input</span>
      <pre className="tool-view-plain">{text.input}</pre>
      {text.output ? (
        <>
          <span className="tool-view-note">Output</span>
          <pre className="tool-view-plain">{text.output}</pre>
        </>
      ) : null}
    </div>
  );
}
