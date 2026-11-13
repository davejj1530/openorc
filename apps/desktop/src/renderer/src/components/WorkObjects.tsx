import { useId, useState } from "react";
import { chipCalls, liveSectionLabel, type CommandObject, type EditObject, type FetchObject, type SearchObject, type ToolObject, type WebObject, type WorkObject } from "@openorc/client";
import { cn } from "../lib/cn";
import { Brain, ChevronRight, Globe, Hammer, Search, Terminal } from "./icons";
import { FileGlyph } from "./FileGlyph";
import { ThreadLink } from "./ThreadImages";
import { GitGraph } from "./WorkGit";
import { ReadView } from "./WorkRead";
import { TestsRun } from "./WorkTests";
import { CallOpenScope, CallRow, SizeBlocks, SizeStat, StateMark, type RenderBlocks } from "./WorkMarks";
import "./WorkObjects.css";

/** The verb in the step's quiet column: what was done to the object, or what is being done while it runs. */
function objectVerb(object: WorkObject): string {
  const verb = doneVerb(object);
  return object.state === "running" ? liveSectionLabel(verb) : verb;
}

/** What was done to each kind of object, as its finished verb. */
const doneVerbs: { [K in WorkObject["kind"]]: (object: Extract<WorkObject, { kind: K }>) => string } = {
  git: (git) => {
    if (git.pullRequest) return git.pullRequest.state === "running" ? "Opening" : "Opened";
    return git.push ? "Pushed" : "Committed";
  },
  tests: (tests) => (tests.state === "running" ? "Testing" : "Tested"),
  edit: (edit) => (edit.created ? "Wrote" : "Edited"),
  read: (read) => (read.rows.every((row) => row.kind === "folder") ? "Listed" : "Read"),
  search: () => "Searched",
  web: () => "Searched",
  fetch: () => "Read",
  command: () => "Ran",
  tool: (tool) => tool.section.replace(/^Used /, ""),
};

function doneVerb(object: WorkObject): string {
  return (doneVerbs[object.kind] as (object: WorkObject) => string)(object);
}

/** One object in a phase: its verb, which opens the calls behind it, and its drawing. */
export function ObjectGroup({ object, renderBlocks }: { object: WorkObject; renderBlocks: RenderBlocks }) {
  const [calls, setCalls] = useState(false);
  const callsId = useId();
  const verb = objectVerb(object);
  return (
    <div className="work-group work-object" data-kind={object.kind} data-state={object.state}>
      <button type="button" className="work-group-label" aria-expanded={calls} aria-controls={callsId} onClick={() => setCalls((value) => !value)}>
        <span key={verb} className="work-object-verb">
          {verb}
        </span>
        <ChevronRight size={10} className={cn("work-chevron", calls && "rotate-90")} />
      </button>
      <div className="work-object-body">
        <CallOpenScope>
          <ObjectView object={object} renderBlocks={renderBlocks} />
        </CallOpenScope>
      </div>
      <div id={callsId} hidden={!calls} className="work-group-calls">
        {calls ? renderBlocks(object.blocks) : null}
      </div>
    </div>
  );
}

function ObjectView({ object, renderBlocks }: { object: WorkObject; renderBlocks: RenderBlocks }) {
  switch (object.kind) {
    case "git":
      return <GitGraph git={object} />;
    case "tests":
      return <TestsRun tests={object} renderBlocks={renderBlocks} />;
    case "edit":
      return <EditView edit={object} renderBlocks={renderBlocks} />;
    case "read":
      return <ReadView read={object} renderBlocks={renderBlocks} />;
    case "search":
      return <SearchView search={object} renderBlocks={renderBlocks} />;
    case "web":
      return <WebView web={object} renderBlocks={renderBlocks} />;
    case "fetch":
      return <FetchView fetch={object} />;
    case "command":
      return <CommandView command={object} renderBlocks={renderBlocks} />;
    case "tool":
      return <ToolView tool={object} renderBlocks={renderBlocks} />;
  }
}

/** An edit as its file and size, and under it the lines it took out and put in; a file it made says New. */
function EditView({ edit, renderBlocks }: { edit: EditObject; renderBlocks: RenderBlocks }) {
  const { chip } = edit;
  const added = chip.added ?? 0;
  const removed = chip.removed ?? 0;
  const lines = edit.lines.length ? (
    <div className="work-edit-lines">
      {edit.lines.map((line, index) => (
        <span key={index} className="work-edit-line" data-sign={line.sign}>
          <span className="work-edit-sign" aria-label={line.sign === "+" ? "Added" : "Removed"}>
            {line.sign === "+" ? "+" : "−"}
          </span>
          {line.text}
        </span>
      ))}
    </div>
  ) : null;
  return (
    <div className="work-edit">
      <CallRow chip={chip} calls={chipCalls(chip)} renderBlocks={renderBlocks} under={lines}>
        <FileGlyph path={chip.label} size={14} className="work-chip-icon" />
        <span className="work-chip-label">{chip.label}</span>
        <span className="work-chip-detail">{chip.detail}</span>
        {edit.created ? <span className="work-chip-note">New</span> : null}
        {edit.state === "failed" ? (
          <span className="work-chip-note" data-tone="bad">
            Failed
          </span>
        ) : null}
        {added || removed ? (
          <>
            <SizeStat added={added} removed={removed} />
            <SizeBlocks added={added} removed={removed} />
          </>
        ) : null}
      </CallRow>
    </div>
  );
}

/** The term marked where a hit's line has it. */
function Marked({ text, term }: { text: string; term: string }) {
  const at = term ? text.toLowerCase().indexOf(term.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="work-hit-term">{text.slice(at, at + term.length)}</mark>
      {text.slice(at + term.length)}
    </>
  );
}

const HITS = 3;
const name = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** A search as what it looked for, then the first lines it found, each opening its file at the line. */
function SearchView({ search, renderBlocks }: { search: SearchObject; renderBlocks: RenderBlocks }) {
  const { chip, hits } = search;
  const term = chip.label.replace(/^["'“/]+|["'”/]+$/g, "");
  const found = hits.length ? (
    <div className="work-hits">
      {hits.slice(0, HITS).map((hit, index) => (
        <ThreadLink key={index} href={hit.line === null ? hit.path : `${hit.path}:${hit.line}`}>
          <span className="work-hit-where">
            {name(hit.path)}
            {hit.line === null ? "" : `:${hit.line}`}
          </span>
          <span className="work-hit-text">
            <Marked text={hit.text} term={term} />
          </span>
        </ThreadLink>
      ))}
    </div>
  ) : null;
  return (
    <div className="work-search">
      <CallRow chip={chip} calls={search.blocks} renderBlocks={renderBlocks} under={found}>
        <Search size={14} className="work-chip-icon" />
        <span className="work-chip-label work-mono">{chip.label}</span>
        <span className="work-chip-detail">{chip.detail}</span>
        {search.matches !== null ? <span className="work-chip-note">{search.matches === 1 ? "1 match" : `${search.matches} matches`}</span> : null}
        <StateMark state={search.state} size={13} quiet />
      </CallRow>
    </div>
  );
}

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

function WebView({ web, renderBlocks }: { web: WebObject; renderBlocks: RenderBlocks }) {
  const results = web.links.length ? (
    <div className="work-results">
      {web.links.slice(0, HITS).map((link) => (
        <ThreadLink key={link.url} href={link.url}>
          <span className="work-result-host">{host(link.url)}</span>
          <span className="work-result-title">{link.title}</span>
        </ThreadLink>
      ))}
    </div>
  ) : null;
  return (
    <div className="work-web">
      <CallRow chip={web.chip} calls={web.blocks} renderBlocks={renderBlocks} under={results}>
        <Globe size={14} className="work-chip-icon" />
        <span className="work-chip-label">{web.chip.label}</span>
        <span className="work-chip-detail" />
        {web.links.length ? <span className="work-chip-note">{web.links.length} results</span> : null}
        <StateMark state={web.state} size={13} quiet />
      </CallRow>
    </div>
  );
}

function FetchView({ fetch }: { fetch: FetchObject }) {
  const path = fetch.url.replace(/^https?:\/\/[^/]+/, "");
  return (
    <div className="work-fetch">
      <span className="work-chip" data-kind="web" data-tip={fetch.url}>
        <ThreadLink href={fetch.url}>
          <Globe size={14} className="work-chip-icon" />
          <span className="work-chip-label">{fetch.chip.label}</span>
          <span className="work-chip-detail">{path === "/" ? "" : path}</span>
        </ThreadLink>
      </span>
      {fetch.excerpt ? <p className="work-quote">{fetch.excerpt}</p> : null}
    </div>
  );
}

/** A command by the agent's words or its plain label; while it runs or once it failed, its newest lines under it. */
function CommandView({ command, renderBlocks }: { command: CommandObject; renderBlocks: RenderBlocks }) {
  const { chip } = command;
  const tail = command.state === "running" || command.state === "failed" ? command.tail : [];
  return (
    <div className="work-command">
      <CallRow
        chip={chip}
        calls={command.blocks}
        renderBlocks={renderBlocks}
        under={
          tail.length ? (
            <div className="work-tail" data-live={command.state === "running" || undefined} data-tone={command.state === "failed" ? "bad" : undefined}>
              {tail.map((line, index) => (
                <span key={`${index}:${line}`}>{line}</span>
              ))}
            </div>
          ) : null
        }
      >
        <Terminal size={14} className="work-chip-icon" />
        <span className="work-chip-label">{chip.label}</span>
        <span className="work-chip-detail">{chip.detail}</span>
        <StateMark state={command.state} size={13} quiet />
      </CallRow>
    </div>
  );
}

function ToolView({ tool, renderBlocks }: { tool: ToolObject; renderBlocks: RenderBlocks }) {
  const Icon = tool.chip.kind === "memory" ? Brain : Hammer;
  return (
    <CallRow chip={tool.chip} calls={tool.blocks} renderBlocks={renderBlocks}>
      <Icon size={14} className="work-chip-icon" />
      <span className="work-chip-label">{tool.chip.label}</span>
      <span className="work-chip-detail">{tool.chip.detail}</span>
      <StateMark state={tool.state} size={13} quiet />
    </CallRow>
  );
}
