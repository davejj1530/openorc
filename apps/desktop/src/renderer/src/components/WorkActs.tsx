import { useMemo, useState, type ReactNode } from "react";
import {
  hitFiles,
  hitTerms,
  lineCall,
  lineEnd,
  lineFile,
  lineMark,
  lineOpens,
  lineState,
  lineWords,
  outputLines,
  printedBy,
  toolInputView,
  workDuration,
  type ActLine,
  type CommandObject,
  type LineResult,
  type TestsObject,
  type WorkObject,
} from "@openorc/client";
import { FileText, GitBranch, Lightbulb, Loader2, Terminal } from "./icons";
import { ThreadLink } from "./ThreadImages";
import { toolIcons } from "./tool-icons";
import { CommandSteps } from "./ToolCommand";
import { GitGraph } from "./WorkGit";
import { ChipIcon, SizeBlocks, SizeStat, type RenderBlocks } from "./WorkMarks";
import { EditLines, WebResults } from "./WorkObjects";
import { fileHref, FilePeek, ReadView } from "./WorkRead";
import { Found } from "./WorkSearch";
import { TestsRun, useTestFiles } from "./WorkTests";
import "./ToolDetail.css";
import "./WorkActs.css";

/** Lines of output a command's screen shows before the rest wait behind a count. */
const SCREEN = 12;

type Run = CommandObject | TestsObject;

/** The thing itself, drawn as what it is. */
function ActBody({ object, renderBlocks }: { object: WorkObject; renderBlocks: RenderBlocks }) {
  switch (object.kind) {
    case "command":
      return <RunView object={object} renderBlocks={renderBlocks} />;
    case "tests":
      return <TestsBody tests={object} renderBlocks={renderBlocks} />;
    case "search":
      return <Found files={hitFiles(object)} terms={hitTerms(object.chip)} unseen={object.hits.every((hit) => hit.line === null) ? Math.max(0, (object.matches ?? 0) - hitFiles(object).length) : 0} />;
    case "read":
      // A read that failed shows the call, which says why.
      return object.state === "failed" ? <div className="work-act-call">{renderBlocks(object.blocks, true)}</div> : <ReadView read={object} renderBlocks={renderBlocks} />;
    case "edit":
      return <EditLines edit={object} />;
    case "web":
      return <WebResults web={object} />;
    case "fetch":
      return <p className="work-quote">{object.excerpt}</p>;
    case "git":
      return <GitGraph git={object} />;
    case "tool":
      return <div className="work-act-call">{renderBlocks(object.blocks, true)}</div>;
  }
}

/** A test run as its results; its screen only when its output named no file to draw, since the results are that output read. */
function TestsBody({ tests, renderBlocks }: { tests: TestsObject; renderBlocks: RenderBlocks }) {
  const { files, cwd } = useTestFiles(tests);
  return (
    <>
      <TestsRun tests={tests} files={files} cwd={cwd} />
      <RunView object={tests} renderBlocks={renderBlocks} screen={!files.length} />
    </>
  );
}

/** The last lines a run printed, on a screen: a pass in green, a failure in red, a caret while it runs. */
function Screen({ text, running, onWhole }: { text: string; running: boolean; onWhole: () => void }) {
  const output = outputLines(text, SCREEN);
  // A screen with nothing on it is a black bar: it waits for the first line.
  if (!output.lines.length) return null;
  return (
    <div className="work-screen" data-live={running || undefined}>
      {output.hidden ? (
        <button type="button" className="work-screen-more" onClick={onWhole}>
          {output.hidden} earlier {output.hidden === 1 ? "line" : "lines"}
        </button>
      ) : null}
      {output.lines.map((line, at) => (
        <span key={`${at}:${line.text}`} data-tone={line.tone ?? undefined}>
          {line.text || " "}
        </span>
      ))}
      {running ? <span className="work-screen-caret" aria-hidden="true" /> : null}
    </div>
  );
}

/**
 * A command as it ran: a screen with the last lines it printed, and under it the command as the steps it ran, each
 * in plain words with any script it fed in. Asking for the earlier lines trades the screen for the call itself.
 * Without a `screen`, as under results that already read the output, the whole output is one press away.
 */
function RunView({ object, renderBlocks, screen = true }: { object: Run; renderBlocks: RenderBlocks; screen?: boolean }) {
  const [whole, setWhole] = useState(false);
  const call = lineCall(object);
  const input = useMemo(() => (call ? toolInputView(call) : null), [call]);
  if (!call) return null;
  const output = screen ? (
    <Screen text={printedBy(object, call)} running={object.state === "running"} onWhole={() => setWhole(true)} />
  ) : (
    <button type="button" className="work-more work-run-whole" onClick={() => setWhole(true)}>
      Whole output
    </button>
  );
  return (
    <div className="work-run">
      {whole ? <div className="work-act-call">{renderBlocks([call], true)}</div> : output}
      {input?.kind === "command" && input.steps.length ? (
        <div className="tool-view work-run-command">
          <CommandSteps steps={input.steps} cwd={input.cwd} />
        </div>
      ) : null}
    </div>
  );
}

/** The mark at a line's start: the file's own for one file, else what kind of thing it is. */
function ActMark({ object }: { object: WorkObject }) {
  const mark = lineMark(object);
  if (mark.kind === "chip") return <ChipIcon chip={mark.chip} />;
  const Icon = mark.kind === "tool" ? toolIcons[mark.icon] : MARKS[mark.kind];
  return <Icon size={14} className="work-chip-icon" />;
}

const MARKS = { git: GitBranch, run: Terminal, unnamed: FileText };

/** Lines listed on their own, such as the searches a folded line holds; the newest is open while the step is on it. */
export function ActGroup({ group, current, renderBlocks }: { group: ActLine[]; current: boolean; renderBlocks: RenderBlocks }) {
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(new Map());
  const newest = current ? group[group.length - 1]!.object.id : undefined;
  const isOpen = (id: string) => chosen.get(id) ?? id === newest;
  return (
    <ol className="work-acts">
      {group.map((line) => (
        <ActRow
          key={line.object.id}
          line={line}
          open={isOpen(line.object.id)}
          current={false}
          onToggle={() => setChosen((known) => new Map(known).set(line.object.id, !isOpen(line.object.id)))}
          renderBlocks={renderBlocks}
        />
      ))}
    </ol>
  );
}

/** How a line came out, at its end: still going, an edit's size, or a few words. */
function ActResult({ result }: { result: LineResult }) {
  if (!result) return null;
  if (result.kind === "running")
    return (
      <>
        <span>{result.since}</span>
        <Loader2 size={14} className="tool-row-live" />
      </>
    );
  if (result.kind === "words") return <span data-tone={result.bad ? "bad" : undefined}>{result.text}</span>;
  const sized = result.added > 0 || result.removed > 0;
  return (
    <>
      {result.created ? <span>New</span> : null}
      {sized ? <SizeBlocks added={result.added} removed={result.removed} /> : null}
      {sized ? <SizeStat added={result.added} removed={result.removed} /> : null}
    </>
  );
}

/** A line's mark, words and result. */
function ActWords({ line }: { line: ActLine }) {
  const words = lineWords(line);
  const end = lineEnd(line);
  return (
    <>
      <ActMark object={line.object} />
      <span className="work-act-words" data-mono={words.code || undefined}>
        {words.verb ? <span className="work-act-verb">{`${words.verb} `}</span> : null}
        <span className="work-act-name">{words.name}</span>
      </span>
      <span className="work-act-result">
        {end.times ? <span>{end.times}</span> : null}
        <ActResult result={end.result} />
      </span>
    </>
  );
}

/**
 * One thing a step did, on its own line: what it was, what it touched and how it came out. Pressing the line opens
 * the thing drawn as what it is, on a piece of its own; pressing again folds it back to the line. One file read is
 * the file's link instead, which shows its lines under the pointer. `current` marks the line the step is on now.
 */
export function ActRow({ line, open, current, onToggle, renderBlocks }: { line: ActLine; open: boolean; current: boolean; onToggle: () => void; renderBlocks: RenderBlocks }) {
  const { object, group } = line;
  // Drawn from the first time it opens, so folding it has something to fold.
  const [seen, setSeen] = useState(open);
  if (open && !seen) setSeen(true);
  const state = lineState(line);
  const file = lineFile(object);
  if (file)
    return (
      <li className="work-act" data-state={state}>
        <FilePeek chip={file} className="work-act-head">
          <ThreadLink href={fileHref(file)}>
            <ActWords line={line} />
          </ThreadLink>
        </FilePeek>
      </li>
    );
  if (!group.length && !lineOpens(object))
    return (
      <li className="work-act" data-state={state}>
        <div className="work-act-head">
          <ActWords line={line} />
        </div>
      </li>
    );
  const body = group.length ? <ActGroup group={group} current={current} renderBlocks={renderBlocks} /> : <ActBody object={object} renderBlocks={renderBlocks} />;
  return (
    <li className="work-act" data-state={state} data-open={open || undefined} data-plane={open ? "" : undefined}>
      <button type="button" className="work-act-head" aria-expanded={open} onClick={onToggle}>
        <ActWords line={line} />
      </button>
      <div hidden={!open} className="work-act-body motion-collapse">
        {seen ? body : null}
      </div>
    </li>
  );
}

/** A step's thoughts as one line, the first of them said in its own words; pressing it shows them in full. */
export function ThoughtRow({ said, took, open, onToggle, children }: { said: string; took: number; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <li className="work-act" data-state="done" data-open={open || undefined} data-plane={open ? "" : undefined}>
      <button type="button" className="work-act-head" aria-expanded={open} onClick={onToggle}>
        <Lightbulb size={14} className="work-chip-icon" />
        <span className="work-act-words">
          <span className="work-act-verb">Thought </span>
          <span className="work-act-name">{said}</span>
        </span>
        <span className="work-act-result">{took >= 1000 ? <span>{workDuration(took)}</span> : null}</span>
      </button>
      <div hidden={!open} className="work-act-body motion-collapse">
        {open ? children : null}
      </div>
    </li>
  );
}
