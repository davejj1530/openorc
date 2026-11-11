import { lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import {
  languageFor,
  toolResult,
  toolResultDetails,
  type ChangedFile,
  type ChangeStatus,
  joinPath,
  toolInputView,
  toolOutputView,
  type Field,
  type InputView,
  type OutputView,
  type Block,
} from "@openorc/client";
import { Globe, Search, WorkDelegate } from "./icons";
import { FileLine, Matches } from "./Matches";
import { ThreadLink, ThreadRichText } from "./ThreadImages";
import { CommandSteps, shortPath } from "./ToolCommand";
import { Code, PrintedText } from "./ToolPrinted";
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
 * reads as its steps in plain words, a printed file as highlighted code, a search as its matches, anything else it
 * printed as read lines. The raw call stays one click away.
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
      return <CommandSteps steps={view.steps} cwd={view.cwd} />;
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
      return <Matches groups={view.groups} highlight={highlighter(view.pattern)} href={(path) => joinPath(cwd, path)} />;
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
    // The tally is in the runner's own summary lines, and the work view draws it; the output reads like any other.
    case "tests":
      return <PrintedText text={view.text} cwd={cwd} />;
    case "json":
      return <Code code={view.json} language="json" startLine={null} />;
    case "markdown":
      return (
        <div className="tool-view-prose prose-chat">
          <ThreadRichText>{view.text}</ThreadRichText>
        </div>
      );
    case "text":
      return <PrintedText text={view.text} cwd={cwd} />;
  }
}

function SearchLine({ pattern, scope, flags }: { pattern: string; scope: string | null; flags: string[] }) {
  return (
    <div className="tool-view-target">
      <Search size={12} className="tool-view-icon" />
      <code className="tool-view-pattern">{pattern}</code>
      {scope ? (
        <span className="tool-view-note" data-tip={scope}>
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
      <span className="tool-view-link" data-tip={target}>
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

/** The search pattern as a highlighter, literal when it is not a valid expression here. */
function highlighter(pattern: string | null): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, "gi");
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  }
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
