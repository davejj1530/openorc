import { Fragment, memo, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { Block } from "../lib/transcript";
import { cn } from "../lib/cn";
import { workDuration } from "../lib/work-transcript";
import { Brain, Check, ChevronRight, Folder, Globe, Hammer, Loader2, Search, Terminal, WorkDelegate } from "./icons";
import { FileGlyph } from "./FileGlyph";
import { useVisited } from "../lib/use-visited";
import { ThreadLink } from "./ThreadImages";
import { chipCalls, type WorkChip } from "./work-chips";
import { chipTitle, isLive, liveHeadline, liveSectionLabel, workEntries, type LiveHeadline, type PlanItem, type WorkEntry, type WorkPhase, type WorkSection } from "./work-steps";
import "./WorkSteps.css";

/** How raw blocks render: the transcript's own rows, so the work list never needs to know them. `open` starts calls open. */
type RenderBlocks = (blocks: Block[], open?: boolean) => ReactNode;

const CHIP_LIMIT = 6;

/**
 * A turn's work as one card of steps. With a plan, its head reads "Step k of n" over a progress track; without one,
 * the phases are the steps. Each step is a row with a ring, a loader or an ink check, and opens to what it touched
 * as chips. `turn` is every block of the turn, so a reply streaming below the work keeps the live row quiet.
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
    <div className="steps-card" data-plane>
      <StepsHead entries={entries} />
      <ol className="work-rail">
        {entries.map((entry) => (
          <EntryView key={entryId(entry)} entry={entry} headline={headline} live={live} renderBlocks={renderBlocks} />
        ))}
        {headline && !headline.entryId ? (
          <li className="work-rail-item" data-state="running">
            <StepMark state="running" />
            <div className="work-phase-title" role="status">
              <LiveWords headline={headline} />
            </div>
          </li>
        ) : null}
      </ol>
    </div>
  );
}

/** Where a plan stands: the step it is on, and how far along the track it is. */
function planProgress(items: PlanItem[]): { count: string; progress: number } {
  const done = items.filter((item) => item.status === "completed").length;
  const current = items.findIndex((item) => item.status !== "completed");
  const working = items.some((item) => item.status === "in_progress") ? 0.5 : 0;
  if (current < 0) return { count: "Done", progress: 1 };
  return { count: `Step ${current + 1} of ${items.length}`, progress: (done + working) / items.length };
}

/** The card's head: the plan's step and track, or how many steps the work took. */
function StepsHead({ entries }: { entries: WorkEntry[] }) {
  const plan = entries.findLast((entry): entry is Extract<WorkEntry, { kind: "plan" }> => entry.kind === "plan");
  if (!plan) return null;
  const { count, progress } = planProgress(plan.items);
  return (
    <div className="steps-head">
      <div className="steps-title">
        <span className="steps-name">Plan</span>
        <span className="steps-count motion-swap">
          <span key={count} className="motion-arrive">
            {count}
          </span>
        </span>
      </div>
      <div className="steps-track" role="progressbar" aria-label="Plan progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
        <span style={{ inlineSize: `${progress * 100}%` }} />
      </div>
    </div>
  );
}

/** The folded work's single line: what the turn is doing now. */
export function WorkNow({ blocks, turn, taskCards = true }: { blocks: Block[]; turn: Block[]; taskCards?: boolean | undefined }) {
  const entries = useMemo(() => workEntries(blocks, taskCards), [blocks, taskCards]);
  const headline = liveHeadline(entries, turn);
  return headline ? (
    <div className="work-now motion-arrive" role="status">
      <Loader2 size={16} className="tool-row-live" />
      <LiveWords headline={headline} elapsed />
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

/** What is happening now, in ink, arriving afresh as it changes; the folded line adds how long it has been going. */
function LiveWords({ headline, elapsed = false }: { headline: LiveHeadline; elapsed?: boolean }) {
  return (
    <>
      <span key={headline.label} className="work-line-text motion-arrive" title={headline.label}>
        {headline.label}
      </span>
      {elapsed ? <Elapsed since={headline.since} /> : null}
    </>
  );
}

type StepState = "pending" | "running" | "done";

/** A step's mark: an empty ring, a loader while it runs, an ink check once done. The check lands with one overshoot. */
function StepMark({ state }: { state: StepState }) {
  return (
    <span className="step-mark" data-state={state} aria-hidden="true">
      {state === "running" ? <Loader2 size={16} className="tool-row-live" /> : null}
      {state === "done" ? (
        <span className="step-check">
          <Check size={11} strokeWidth={2.25} />
        </span>
      ) : null}
      {state === "pending" ? <span className="step-ring" /> : null}
    </span>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A folded phase's hint of what is inside: "6 files · 2 commands". */
function phaseMeta(phase: WorkPhase): string {
  const count = (labels: string[]) => phase.sections.filter((section) => labels.includes(section.label)).reduce((sum, section) => sum + section.chips.length, 0);
  const files = count(["Read", "Edited"]);
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
  const visited = useVisited(open);
  const bodyId = useId();
  const expandable = phase.sections.length > 0 || phase.extras.length > 0 || phase.thoughts.length > 0 || Boolean(phase.detail || phase.narration);
  return (
    <li className="work-rail-item" data-state={live ? "running" : "done"}>
      <StepMark state={live ? "running" : "done"} />
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
        <div id={bodyId} hidden={!open} className="work-phase-body motion-collapse">
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
  // A phase named after its one call ("Run the desktop tests") opens straight to that call. A command's card
  // already shows the command and its last line, so it stays closed rather than repeat them.
  const section = phase.sections.length === 1 ? phase.sections[0]! : null;
  const only = section?.chips.length === 1 ? section.chips[0]! : null;
  if (only && chipTitle(only) === phase.title && !phase.extras.length) return <div className="work-group-calls">{renderBlocks(only.blocks, section?.label !== "Ran")}</div>;
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
 * One kind of work in a phase: its verb ("Read") in a quiet column, then what it touched as aligned rows. The verb
 * opens the calls themselves. An activity with nothing to list is its own row already.
 */
function GroupView({ section, live, renderBlocks }: { section: WorkSection; live: boolean; renderBlocks: RenderBlocks }) {
  const activities = section.blocks.filter((block) => block.kind === "activity");
  if (!section.chips.length && activities.length) return <div className="work-group-blocks">{renderBlocks(activities)}</div>;
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
  const first = section.chips.slice(0, CHIP_LIMIT);
  // The call under way stays in view, in place of the last row that fits.
  const current = running ? section.chips.findLast((chip) => chip.blocks.some(isLive)) : undefined;
  const fitting = current && !first.includes(current) ? [...first.slice(0, -1), current] : first;
  const shown = all ? section.chips : fitting;
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
        <ChevronRight size={10} className={cn("work-chevron", calls && "rotate-90")} />
      </button>
      <div className="work-chips">
        {shown.map((chip) => (
          <Fragment key={chip.key}>
            <ChipView chip={chip} live={live && chip.blocks.some(isLive)} picked={chip.key === picked} onPick={() => setPicked((key) => (key === chip.key ? null : chip.key))} />
            {chip === pick ? <div className="work-group-calls">{renderBlocks(chipCalls(pick), true)}</div> : null}
          </Fragment>
        ))}
        {section.chips.length > shown.length ? (
          <button type="button" className="work-more" onClick={() => setAll(true)}>
            {section.chips.length - shown.length} more
          </button>
        ) : null}
      </div>
      <div id={callsId} hidden={!calls} className="work-group-calls">
        {visited ? renderBlocks(section.blocks) : null}
      </div>
    </div>
  );
}

const kindIcons = { folder: Folder, query: Search, command: Terminal, intent: Terminal, web: Globe, tool: Hammer, agent: WorkDelegate, memory: Brain } as const;

/** A file shows its language's mark; anything else shows what kind of thing it is. */
function ChipIcon({ chip }: { chip: WorkChip }) {
  if (chip.kind === "file" || chip.kind === "edit") return <FileGlyph path={chip.label} size={14} className="work-chip-icon" />;
  const Icon = kindIcons[chip.kind];
  return <Icon size={14} className="work-chip-icon" />;
}

/**
 * A row: the mark, the name, a faint detail that fills the middle (a file's folder, a search's scope), and at the
 * end a faint note (the lines read, the matches found) or an edit's line counts.
 */
function ChipView({ chip, live, picked, onPick }: { chip: WorkChip; live: boolean; picked: boolean; onPick: () => void }) {
  const content = (
    <>
      <ChipIcon chip={chip} />
      <span className="work-chip-label">{chip.label}</span>
      {/* A file's title carries its whole path, so its folder stays out of the row's name. */}
      <span className="work-chip-detail" aria-hidden={chip.path ? true : undefined}>
        {chip.detail}
      </span>
      {chip.note ? <span className="work-chip-note">{chip.note}</span> : null}
      {chip.added ? <span className="work-stat-added">+{chip.added}</span> : null}
      {chip.removed ? <span className="work-stat-removed">−{chip.removed}</span> : null}
    </>
  );
  // A file read opens the file; an edit, like any other call, opens below the chips to show what it did.
  if (chip.kind === "file" && chip.path)
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

const planStates: Record<PlanItem["status"], (live: boolean) => StepState> = {
  completed: () => "done",
  in_progress: (live) => (live ? "running" : "pending"),
  pending: () => "pending",
};

/** The agent's plan as steps that check off in place, the one it is on in ink. */
function PlanView({ items, live }: { items: PlanItem[]; live: boolean }) {
  return (
    <li className="work-rail-item work-plan">
      <ol className="work-plan-items">
        {items.map((item, index) => (
          <li key={index} className="work-plan-item" data-status={item.status}>
            <StepMark state={planStates[item.status](live)} />
            <span className="min-w-0">{item.text}</span>
          </li>
        ))}
      </ol>
    </li>
  );
}
