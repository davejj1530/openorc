import { memo, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { ProjectStackIconId } from "../../../shared/project-stack-icons";
import type { Block } from "../lib/transcript";
import { cn } from "../lib/cn";
import { workDuration } from "../lib/work-transcript";
import { Brain, Check, ChevronRight, CircleDashed, FileCode2, FileText, Folder, Globe, Hammer, Image, ListChecks, Search, Terminal, WorkDelegate, WorkLive } from "./icons";
import { ProjectStackIcon } from "./ProjectStackIcon";
import { ThreadLink } from "./ThreadImages";
import type { WorkChip } from "./work-chips";
import { isLive, liveHeadline, liveSectionLabel, workEntries, type LiveHeadline, type PlanItem, type WorkEntry, type WorkPhase, type WorkSection } from "./work-steps";
import "./WorkSteps.css";

/** How raw blocks render: the transcript's own rows, so the work list never needs to know them. `open` starts calls open. */
type RenderBlocks = (blocks: Block[], open?: boolean) => ReactNode;

const CHIP_LIMIT = 6;

/**
 * A turn's work on a rail: a dot and a title per phase, what each phase touched as chips under it, and the one
 * thing happening now carried by a single live line. `turn` is every block of the turn, so a reply streaming below
 * the work keeps the line quiet.
 */
export function WorkSteps({
  blocks,
  turn,
  live,
  taskCards = true,
  pinned,
  renderBlocks,
}: {
  blocks: Block[];
  turn: Block[];
  live: boolean;
  taskCards?: boolean | undefined;
  pinned?: string | undefined;
  renderBlocks: RenderBlocks;
}) {
  const entries = useMemo(() => workEntries(blocks, taskCards, pinned), [blocks, taskCards, pinned]);
  const headline = live ? liveHeadline(entries, turn) : null;
  return (
    <ol className="work-rail">
      {entries.map((entry) => (
        <EntryView key={entryId(entry)} entry={entry} headline={headline} live={live} renderBlocks={renderBlocks} />
      ))}
      {headline && !headline.entryId ? (
        <li className="work-rail-item" data-state="running">
          <RailDot live />
          <div className="work-phase-title" role="status">
            <LiveWords headline={headline} />
          </div>
        </li>
      ) : null}
    </ol>
  );
}

/** The folded work's single line: what the turn is doing now. */
export function WorkNow({ blocks, turn, taskCards = true }: { blocks: Block[]; turn: Block[]; taskCards?: boolean | undefined }) {
  const entries = useMemo(() => workEntries(blocks, taskCards), [blocks, taskCards]);
  const headline = liveHeadline(entries, turn);
  return headline ? (
    <div className="work-now" role="status">
      <span className="work-now-dot" aria-hidden="true">
        <span className="work-pulse" />
      </span>
      <LiveWords headline={headline} />
    </div>
  ) : null;
}

function entryId(entry: WorkEntry): string {
  return entry.kind === "phase" ? entry.phase.id : entry.id;
}

function EntryView({ entry, headline, live, renderBlocks }: { entry: WorkEntry; headline: LiveHeadline | null; live: boolean; renderBlocks: RenderBlocks }) {
  if (entry.kind === "phase") {
    const current = headline?.entryId === entry.phase.id ? headline : null;
    return <PhaseView phase={entry.phase} headline={current} renderBlocks={renderBlocks} />;
  }
  if (entry.kind === "plan") return <PlanView items={entry.items} live={live} />;
  return (
    <li className="work-rail-item">
      <span className="work-rail-dot" aria-hidden="true" />
      <div className="work-rail-blocks">{renderBlocks(entry.blocks)}</div>
    </li>
  );
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** Kept out of accessible names and the live region: a reading that changes every second is noise there. */
function Elapsed({ since }: { since: number | undefined }) {
  const now = useNow(since !== undefined);
  return since === undefined ? null : (
    <span className="work-elapsed" aria-hidden="true">
      {workDuration(now - since)}
    </span>
  );
}

/** The accent, a slow light passing through the words, and how long it has been going. */
function LiveWords({ headline }: { headline: LiveHeadline }) {
  return (
    <>
      <span className="work-line-text work-shimmer" title={headline.label}>
        {headline.label}
      </span>
      <Elapsed since={headline.since} />
    </>
  );
}

function RailDot({ live = false }: { live?: boolean }) {
  return (
    <span className="work-rail-dot" aria-hidden="true">
      {live ? (
        <span className="work-pulse" />
      ) : (
        <span className="work-done">
          <Check size={10} />
        </span>
      )}
    </span>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A folded phase's hint of what is inside: "6 files · 2 commands". */
function phaseMeta(phase: WorkPhase): string {
  const count = (labels: string[]) => phase.sections.filter((section) => labels.includes(section.label)).reduce((sum, section) => sum + section.chips.length, 0);
  const files = count(["Read", "Edited", "Listed"]);
  const searches = count(["Searched", "Searched the web", "Searched memory"]);
  const commands = count(["Ran"]);
  return [files ? plural(files, "file") : "", searches ? plural(searches, "search", "searches") : "", commands ? plural(commands, "command") : ""].filter(Boolean).slice(0, 2).join(" · ");
}

type PhaseProps = { phase: WorkPhase; headline: LiveHeadline | null; renderBlocks: RenderBlocks };

/** A finished phase whose blocks are all the same objects has nothing new to show while another streams. */
const samePhase = (a: PhaseProps, b: PhaseProps) =>
  a.phase.id === b.phase.id &&
  a.phase.title === b.phase.title &&
  a.headline?.label === b.headline?.label &&
  a.headline?.since === b.headline?.since &&
  a.phase.blocks.length === b.phase.blocks.length &&
  a.phase.blocks.every((block, i) => block === b.phase.blocks[i]);

/** Open while it is the live phase, folded once it is done, unless the reader chose. */
const PhaseView = memo(function PhaseView({ phase, headline, renderBlocks }: PhaseProps) {
  const live = headline !== null;
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? live;
  const [visited, setVisited] = useState(open);
  useEffect(() => {
    if (open) setVisited(true);
  }, [open]);
  const bodyId = useId();
  const expandable = phase.sections.length > 0 || phase.extras.length > 0 || phase.thoughts.length > 0 || Boolean(phase.detail || phase.narration);
  return (
    <li className="work-rail-item" data-state={live ? "running" : "done"}>
      <RailDot live={live} />
      <button
        type="button"
        className="work-phase-title"
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        aria-controls={expandable ? bodyId : undefined}
        onClick={() => setChoice(!open)}
      >
        <PhaseWords phase={phase} headline={headline} open={open} />
        {expandable ? <ChevronRight size={12} className={cn("work-chevron", open && "rotate-90")} /> : null}
      </button>
      {expandable ? (
        <div id={bodyId} hidden={!open} className="work-phase-body">
          {visited ? <PhaseBody phase={phase} live={live} renderBlocks={renderBlocks} /> : null}
        </div>
      ) : null}
    </li>
  );
}, samePhase);

/** The live words while the phase runs; otherwise its title, and when folded a hint of what is inside. */
function PhaseWords({ phase, headline, open }: { phase: WorkPhase; headline: LiveHeadline | null; open: boolean }) {
  if (headline) return <LiveWords headline={headline} />;
  const meta = !open && phase.origin !== "summary" ? phaseMeta(phase) : "";
  return (
    <>
      <span className="work-line-text" title={phase.title}>
        {phase.title}
      </span>
      {meta ? <span className="work-phase-meta">{meta}</span> : null}
    </>
  );
}

function PhaseBody({ phase, live, renderBlocks }: { phase: WorkPhase; live: boolean; renderBlocks: RenderBlocks }) {
  // A phase named after its one call ("Run the desktop tests") opens straight to that call.
  const only = phase.sections.length === 1 && phase.sections[0]!.chips.length === 1 ? phase.sections[0]!.chips[0]! : null;
  if (only?.label === phase.title && !phase.extras.length) return <div className="work-group-calls">{renderBlocks(only.blocks, true)}</div>;
  return (
    <>
      {phase.detail ? <p className="work-phase-detail">{phase.detail}</p> : null}
      {phase.narration ? <div className="work-phase-narration">{renderBlocks([phase.narration])}</div> : null}
      {phase.thoughts.length ? (
        <ol className="work-thoughts">
          {phase.thoughts.map((thought, index) => (
            <li key={index} title={thought.body || undefined}>
              {thought.title}
            </li>
          ))}
        </ol>
      ) : null}
      {phase.sections.map((section) => (
        <GroupView key={section.id} section={section} live={live} renderBlocks={renderBlocks} />
      ))}
      {phase.extras.length ? <div className="work-phase-extras">{renderBlocks(phase.extras)}</div> : null}
    </>
  );
}

/**
 * One kind of work in a phase: a small label ("Read 6"), then what it touched as chips. The label opens the calls
 * themselves. An activity with nothing to chip is its own row already.
 */
function GroupView({ section, live, renderBlocks }: { section: WorkSection; live: boolean; renderBlocks: RenderBlocks }) {
  const activities = section.blocks.filter((block) => block.kind === "activity");
  if (!section.chips.length && activities.length) return <div className="work-group">{renderBlocks(activities)}</div>;
  return <ChipGroup section={section} live={live} renderBlocks={renderBlocks} />;
}

function ChipGroup({ section, live, renderBlocks }: { section: WorkSection; live: boolean; renderBlocks: RenderBlocks }) {
  const [all, setAll] = useState(false);
  const [calls, setCalls] = useState(false);
  // A chip the reader picked shows its own call, already open, under the chips.
  const [picked, setPicked] = useState<string | null>(null);
  const pick = section.chips.find((chip) => chip.key === picked);
  const [visited, setVisited] = useState(false);
  const callsId = useId();
  const running = live && section.blocks.some(isLive);
  const shown = all ? section.chips : section.chips.slice(0, CHIP_LIMIT);
  return (
    <div className="work-group">
      <button
        type="button"
        className="work-group-label"
        aria-expanded={calls}
        aria-controls={callsId}
        onClick={() => {
          setVisited(true);
          setCalls((value) => !value);
        }}
      >
        <span>{running ? liveSectionLabel(section.label) : section.label}</span>
        {section.chips.length > 1 ? <span className="work-count">{section.chips.length}</span> : null}
        <ChevronRight size={10} className={cn("work-chevron", calls && "rotate-90")} />
      </button>
      {shown.length ? (
        <div className="work-chips">
          {shown.map((chip) => (
            <ChipView key={chip.key} chip={chip} live={live && chip.blocks.some(isLive)} picked={chip.key === picked} onPick={() => setPicked((key) => (key === chip.key ? null : chip.key))} />
          ))}
          {section.chips.length > shown.length ? (
            <button type="button" className="work-more" onClick={() => setAll(true)}>
              +{section.chips.length - shown.length} more
            </button>
          ) : null}
        </div>
      ) : null}
      {pick ? <div className="work-group-calls">{renderBlocks(pick.blocks, true)}</div> : null}
      <div id={callsId} hidden={!calls} className="work-group-calls">
        {visited ? renderBlocks(section.blocks) : null}
      </div>
    </div>
  );
}

const languages: Record<string, ProjectStackIconId> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "react",
  jsx: "react",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
};

const kindIcons = { folder: Folder, query: Search, command: Terminal, intent: Terminal, web: Globe, tool: Hammer, agent: WorkDelegate, memory: Brain } as const;

/** A file shows its language's mark where we ship one; anything else shows what kind of thing it is. */
function ChipIcon({ chip }: { chip: WorkChip }) {
  if (chip.kind !== "file") {
    const Icon = kindIcons[chip.kind];
    return <Icon size={12} className="work-chip-icon" />;
  }
  const extension = /\.([a-z0-9]+)$/i.exec(chip.label)?.[1]?.toLowerCase() ?? "";
  const language = languages[extension];
  if (language) return <ProjectStackIcon id={language} size={12} />;
  if (/^(png|jpe?g|gif|webp|svg|avif|ico)$/.test(extension)) return <Image size={12} className="work-chip-icon" />;
  if (/^(md|mdx|txt|rst)$/.test(extension)) return <FileText size={12} className="work-chip-icon" />;
  return <FileCode2 size={12} className="work-chip-icon" />;
}

/** A file chip opens the file; any other chip shows the call behind it. */
function ChipView({ chip, live, picked, onPick }: { chip: WorkChip; live: boolean; picked: boolean; onPick: () => void }) {
  const content = (
    <>
      <ChipIcon chip={chip} />
      <span className="work-chip-label">{chip.label}</span>
      {chip.added ? <span className="work-stat-added">+{chip.added}</span> : null}
      {chip.removed ? <span className="work-stat-removed">−{chip.removed}</span> : null}
    </>
  );
  if (chip.path)
    return (
      <span className="work-chip" data-kind={chip.kind} data-live={live || undefined} title={chip.title}>
        <ThreadLink href={chip.path}>{content}</ThreadLink>
      </span>
    );
  return (
    <button type="button" className="work-chip" data-kind={chip.kind} data-live={live || undefined} title={chip.title} aria-pressed={picked} onClick={onPick}>
      {content}
    </button>
  );
}

const planIcon: Record<PlanItem["status"], (live: boolean) => ReactNode> = {
  completed: () => <Check size={14} className="text-ok" />,
  in_progress: (live) => <WorkLive size={14} className={cn("text-accent-ink", live && "work-live")} />,
  pending: () => <CircleDashed size={14} className="text-ink-4" />,
};

/** The agent's plan as a checklist that updates in place, with the step it is on in the accent. */
function PlanView({ items, live }: { items: PlanItem[]; live: boolean }) {
  const done = items.filter((item) => item.status === "completed").length;
  return (
    <li className="work-rail-item">
      <span className="work-rail-dot" aria-hidden="true">
        <ListChecks size={14} />
      </span>
      <div className="work-phase-title">
        <span className="work-line-text">Plan</span>
        <span className="work-plan-count">
          {done} of {items.length}
        </span>
      </div>
      <ol className="work-plan-items">
        {items.map((item, index) => (
          <li key={index} className="work-plan-item" data-status={item.status}>
            <span className="work-plan-icon">{planIcon[item.status](live)}</span>
            <span className="min-w-0">{item.text}</span>
          </li>
        ))}
      </ol>
    </li>
  );
}
