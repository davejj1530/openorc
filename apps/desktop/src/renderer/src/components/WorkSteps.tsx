import { memo, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  type Block,
  workDuration,
  isSignal,
  liveHeadline,
  workEntries,
  type LiveHeadline,
  type PlanItem,
  type WorkEntry,
  type WorkPhase,
  useTicking,
  workObjects,
  type WorkObject,
  firstThought,
  stepCounts,
  stepLines,
  stepRows,
  stepThoughts,
  stepTitle,
  stepWaiting,
  type ActLine,
  type StepThoughts,
} from "@openorc/client";
import { cn } from "../lib/cn";
import { Check, ChevronRight, Lightbulb, List, Loader2, Workflow, X } from "./icons";
import type { RenderBlocks } from "./WorkMarks";
import { ActRow, ThoughtRow } from "./WorkActs";
import { WorkTimeline } from "./WorkTimeline";
import "./WorkSteps.css";

/**
 * A turn's work as writing on the conversation's own ground. Each step has one shape, running or done, and never
 * folds on its own: what the agent said about it in full, or else its name, then one line of the things it touched
 * as words, in the order they happened. A word shows its thing under the step. With a plan, a head reads "Step k of
 * n" over a progress track. `turn` is every block of the turn, so a reply streaming below the work keeps the live
 * step quiet.
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
  const every = useMemo(() => workEntries(blocks, taskCards, pinned), [blocks, taskCards, pinned]);
  // While the turn runs, its live line says it is waiting; a finished wait is not a row of its own.
  const entries = useMemo(() => (live ? every.filter((entry) => entry.kind !== "blocks" || !entry.blocks.every(isSignal)) : every), [every, live]);
  const headline = live ? liveHeadline(entries, turn) : null;
  // The same work, drawn in time, for a closer look.
  const [timeline, setTimeline] = useState(false);
  // The timeline draws what a turn changed, so a turn that changed nothing has none.
  const steps = entries.some((entry) => entry.kind === "phase" && entry.phase.sections.some((section) => section.label === "Edited"));
  if (timeline && steps)
    return (
      <div className="work-written">
        <div className="motion-arrive">
          <WorkTimeline entries={entries} turn={turn} live={live} renderBlocks={renderBlocks} />
        </div>
        <ViewSwap timeline onSwap={() => setTimeline(false)} />
      </div>
    );
  return (
    <div className="work-written">
      <StepsHead entries={entries} />
      <ol className="work-lines">
        {entries.map((entry) => (
          <EntryView key={entryId(entry)} entry={entry} turn={turn} headline={headline} live={live} renderBlocks={renderBlocks} />
        ))}
        {headline && !headline.entryId ? (
          <li className="work-line" data-state="running" role="status">
            <LiveLine headline={headline} />
          </li>
        ) : null}
      </ol>
      {steps ? <ViewSwap timeline={false} onSwap={() => setTimeline(true)} /> : null}
    </div>
  );
}

/** Swaps the sentences for the timeline and back, in place. */
function ViewSwap({ timeline, onSwap }: { timeline: boolean; onSwap: () => void }) {
  const Icon = timeline ? List : Workflow;
  return (
    <button type="button" className="work-view-swap" onClick={onSwap}>
      <Icon size={14} />
      {timeline ? "Summary" : "Timeline"}
    </button>
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

/**
 * The folded work's single line: what the turn is doing now. `lead` says how that stands to the reader's message,
 * for work a newer message is waiting behind.
 */
export function WorkNow({ blocks, turn, taskCards = true, lead }: { blocks: Block[]; turn: Block[]; taskCards?: boolean | undefined; lead?: string }) {
  const entries = useMemo(() => workEntries(blocks, taskCards), [blocks, taskCards]);
  const headline = liveHeadline(entries, turn);
  return headline ? (
    <div className="work-now motion-arrive" role="status">
      <Loader2 size={16} className="tool-row-live" />
      {lead ? <span className="work-now-lead">{lead}</span> : null}
      <LiveWords headline={headline} elapsed />
    </div>
  ) : null;
}

/**
 * A call an earlier turn started that is still running. A message sent meanwhile is read once it ends, so until the
 * newest turn has work of its own, its place says what is being finished first.
 */
export function CarriedWork({
  showActivity,
  live,
  work,
  carried,
  named,
  taskCards,
}: {
  showActivity: boolean;
  live: boolean;
  work: Block[];
  carried: Block[] | undefined;
  named: string | undefined;
  taskCards: boolean | undefined;
}) {
  if (!showActivity || !live || work.length || !carried?.length) return null;
  return (
    <section className="work-section" aria-label={named ? `${named}’s work` : "Agent work"}>
      <WorkNow blocks={carried} turn={carried} taskCards={taskCards} lead="Finishing first:" />
    </section>
  );
}

function entryId(entry: WorkEntry): string {
  return entry.kind === "phase" ? entry.phase.id : entry.id;
}

function EntryView({ entry, turn, headline, live, renderBlocks }: { entry: WorkEntry; turn: Block[]; headline: LiveHeadline | null; live: boolean; renderBlocks: RenderBlocks }) {
  if (entry.kind === "phase") {
    const current = headline?.entryId === entry.phase.id ? headline : null;
    const message = entry.phase.origin === "narration" ? entry.phase.source?.id : undefined;
    // Only the live phase reads the rest of the turn (a test run's earlier count), so finished phases hold still while it streams.
    return <PhaseView phase={entry.phase} headline={current} earlier={current ? turn : undefined} settled={!live} message={message} renderBlocks={renderBlocks} />;
  }
  if (entry.kind === "plan") return <PlanView items={entry.items} live={live} />;
  return (
    <li className="work-line">
      <div className="work-rail-blocks">{renderBlocks(entry.blocks)}</div>
    </li>
  );
}

/** Kept out of accessible names and the live region: a reading that changes every second is noise there. */
function Elapsed({ since }: { since: number | undefined }) {
  const now = useTicking(since !== undefined);
  return since === undefined ? null : (
    <span className="work-elapsed" aria-hidden="true">
      {workDuration(now - since)}
    </span>
  );
}

/** What is happening now, in ink, arriving afresh as it changes; the folded line adds how long it has been going. */
function LiveWords({ headline, elapsed = false }: { headline: LiveHeadline; elapsed?: boolean }) {
  // A thought with words says more than "Thinking" does.
  const words = headline.thought ?? headline.label;
  return (
    <>
      <span key={words} className="work-line-text motion-arrive" data-tip={words}>
        {words}
      </span>
      {elapsed ? <Elapsed since={headline.since} /> : null}
    </>
  );
}

/**
 * What the turn is doing between its calls, as a line that moves: its words shimmer and its seconds count. A
 * thought no step shows is open under it, its newest lines arriving as they are written.
 */
function LiveLine({ headline }: { headline: LiveHeadline }) {
  const { thinking } = headline;
  return (
    <div className="work-act work-live" data-state="running">
      <div className="work-act-head">
        {thinking ? <Lightbulb size={14} className="work-chip-icon" /> : <Loader2 size={14} className="tool-row-live" />}
        <span className="work-act-words">
          <span className="work-live-words">{thinking ? "Thinking" : headline.label}</span>
        </span>
        <span className="work-act-result">
          <Elapsed since={headline.since} />
        </span>
      </div>
      {headline.aside ? <LiveThought text={headline.aside} /> : null}
    </div>
  );
}

/**
 * A thought as it is written: its newest lines. Once it is taller than its room the older lines run off the top,
 * and only then does the top fade.
 */
function LiveThought({ text }: { text: string }) {
  const room = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  useLayoutEffect(() => {
    const element = room.current;
    const written = element?.firstElementChild;
    if (element && written instanceof HTMLElement) setOver(written.offsetHeight > element.clientHeight + 1);
  }, [text]);
  return (
    <div ref={room} className="work-live-thought" data-over={over || undefined}>
      <p>{text}</p>
    </div>
  );
}

export type StepState = "pending" | "running" | "done" | "failed";

/**
 * A step's mark: an empty ring, a loader while it runs, an ink check once done, a cross once it failed. Checks and
 * crosses land with one overshoot.
 */
export function StepMark({ state }: { state: StepState }) {
  return (
    <span className="step-mark" data-state={state} aria-hidden="true">
      {state === "running" ? <Loader2 size={16} className="tool-row-live" /> : null}
      {state === "done" ? (
        <span className="step-check">
          <Check size={11} strokeWidth={2.25} />
        </span>
      ) : null}
      {state === "failed" ? (
        <span className="step-check" data-failed="">
          <X size={11} strokeWidth={2.25} />
        </span>
      ) : null}
      {state === "pending" ? <span className="step-ring" /> : null}
    </span>
  );
}

/** `message` is the narration the phase is named after, which marks the step when that message is asked for. */
type PhaseProps = {
  phase: WorkPhase;
  headline: LiveHeadline | null;
  /** The turn's blocks, for the live phase only. */
  earlier: Block[] | undefined;
  /** The turn has ended, so a call still open stopped with it. */
  settled: boolean;
  message?: string | undefined;
  renderBlocks: RenderBlocks;
};

/** A finished phase whose blocks are all the same objects has nothing new to show while another streams. */
const samePhase = (a: PhaseProps, b: PhaseProps) =>
  a.phase.id === b.phase.id &&
  a.phase.title === b.phase.title &&
  a.headline?.label === b.headline?.label &&
  a.headline?.since === b.headline?.since &&
  a.headline?.thinking === b.headline?.thinking &&
  a.earlier === b.earlier &&
  a.settled === b.settled &&
  a.phase.blocks.length === b.phase.blocks.length &&
  a.phase.blocks.every((block, i) => block === b.phase.blocks[i]);

/**
 * Which of a step's lines are open. While the step runs, the newest thing it did is open and the ones before it are
 * each one line; once it is done they all are. A line the reader pressed stays as they left it.
 */
function useOpenLines(current: string | undefined) {
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(new Map());
  const isOpen = (id: string) => chosen.get(id) ?? id === current;
  return { isOpen, toggle: (id: string) => setChosen((known) => new Map(known).set(id, !isOpen(id))) };
}

const isExpandable = (phase: WorkPhase) => phase.sections.length > 0 || phase.extras.length > 0 || phase.thoughts.length > 0 || Boolean(phase.detail || phase.narration);

/** The id a step's thoughts open under, beside the ids of its things. */
const THOUGHTS = "thoughts";

/** A step's thoughts, in full: each titled one with what it said, then the untitled ones as written. */
function StepThoughts({ titled, texts }: Pick<StepThoughts, "titled" | "texts">) {
  return (
    <div className="work-thoughts motion-stagger">
      {titled.map((thought, index) => (
        <p key={index} className="motion-arrive">
          <span className="work-thought-title">{thought.title}</span>
          {thought.body ? ` ${thought.body}` : null}
        </p>
      ))}
      {texts
        .flatMap((text) => text.split(/\n\s*\n/))
        .filter((paragraph) => paragraph.trim())
        .map((paragraph, index) => (
          <p key={`text-${index}`} className="motion-arrive">
            {paragraph}
          </p>
        ))}
    </div>
  );
}

const PhaseView = memo(function PhaseView({ phase, headline, earlier, settled, message, renderBlocks }: PhaseProps) {
  const live = headline !== null;
  const objects = useMemo(() => workObjects(phase.blocks, earlier ?? phase.blocks, !settled), [phase.blocks, earlier, settled]);
  const acts = useMemo(() => stepLines(phase, objects), [phase, objects]);
  const [opened, setOpened] = useState(true);
  const bodyId = useId();
  const expandable = isExpandable(phase);
  const title = stepTitle(phase, objects);
  // What the agent wrote stands as the step's head, in full; its name is only a sentence of that.
  const said = phase.narration;
  // A step named after its one call would say that call twice: its line stands alone.
  const named = said !== null || phase.origin !== "summary" || acts.length !== 1;
  const shown = opened || said !== null;
  const name = named ? (
    <button
      type="button"
      className="work-name"
      disabled={!expandable}
      aria-expanded={expandable ? opened : undefined}
      aria-controls={expandable ? bodyId : undefined}
      onClick={() => setOpened((value) => !value)}
    >
      <span className="work-line-text" data-tip={title}>
        {title}
      </span>
      {expandable ? <ChevronRight size={12} className={cn("work-chevron", opened && "rotate-90")} /> : null}
    </button>
  ) : null;
  return (
    <li className="work-line" data-state={live ? "running" : "done"} data-message={message}>
      {said ? <div className="work-phase-narration">{renderBlocks([said])}</div> : name}
      <div id={bodyId} hidden={!shown} className="work-opened motion-collapse">
        <PhaseOpened phase={phase} objects={objects} acts={acts} live={live && !headline?.thinking} renderBlocks={renderBlocks} />
      </div>
      <CameLine phase={phase} objects={objects} opened={shown} wait={stepWaiting(headline, title, objects)} />
    </li>
  );
}, samePhase);

/**
 * Under a step: how much looking around a folded one took, as counts, and what fills a wait while it runs. A step
 * named after its calls counts them in its name already, and an open step lists every thing it did.
 */
function CameLine({ phase, objects, opened, wait }: { phase: WorkPhase; objects: WorkObject[]; opened: boolean; wait: LiveHeadline | null }) {
  const counts = opened || phase.origin === "summary" ? "" : stepCounts(objects);
  return (
    <>
      {counts ? <p className="work-came">{counts}</p> : null}
      {wait ? <LiveLine headline={wait} /> : null}
    </>
  );
}

/**
 * A step's body: everything it did, each thing on its own line in the order it happened, its thoughts first. While
 * the step runs the newest line is open; the ones before it have folded to a line each.
 */
function PhaseOpened({ phase, objects, acts, live, renderBlocks }: { phase: WorkPhase; objects: WorkObject[]; acts: ActLine[]; live: boolean; renderBlocks: RenderBlocks }) {
  const thoughts = useMemo(() => stepThoughts(phase), [phase]);
  // A tool's call is its raw request and answer, which waits to be asked for; everything else opens while it is the newest.
  const newest = acts[acts.length - 1]?.object;
  const { isOpen, toggle } = useOpenLines(live && newest && newest.kind !== "tool" ? newest.id : undefined);
  const { rows, alone } = useMemo(() => stepRows(phase, objects), [phase, objects]);
  return (
    <>
      {phase.detail ? <p className="work-phase-detail">{phase.detail}</p> : null}
      <ol className="work-acts">
        {thoughts.titled.length || thoughts.texts.length ? (
          <ThoughtRow said={firstThought(thoughts)} took={thoughts.took} open={isOpen(THOUGHTS)} onToggle={() => toggle(THOUGHTS)}>
            <StepThoughts titled={thoughts.titled} texts={thoughts.texts} />
          </ThoughtRow>
        ) : null}
        {acts.map((line) => (
          <ActRow key={line.object.id} line={line} open={isOpen(line.object.id)} current={live && line === acts[acts.length - 1]} onToggle={() => toggle(line.object.id)} renderBlocks={renderBlocks} />
        ))}
      </ol>
      {rows.length ? <div className="work-group-blocks">{renderBlocks(rows)}</div> : null}
      {alone.length ? <div className="work-phase-extras">{renderBlocks(alone)}</div> : null}
    </>
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
