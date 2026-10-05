import type { Block } from "../lib/transcript";
import { isImageGeneration, isImageView } from "../lib/image-activity";
import { toolShowsCard } from "../lib/task-progress";
import { callParts, type WorkChip } from "./work-chips";

/**
 * A turn's work as a few phases, the way the agent meant it rather than as a log of calls. A phase opens where the
 * agent says what it is about to do: a Codex reasoning title ("Inspecting the status row") or the sentence Claude
 * writes before a batch of calls ("Checking the ledger to confirm"). Under it, what the phase touched is grouped by
 * kind (Searched, Read, Edited, Ran) as chips. Calls before any such words get a phase named after what they did.
 */
export type WorkEntry = { kind: "phase"; phase: WorkPhase } | { kind: "plan"; id: string; block: Block; items: PlanItem[] } | { kind: "blocks"; id: string; blocks: Block[] };

export interface WorkPhase {
  id: string;
  title: string;
  /** Whose words the title is: a reasoning title, the agent's narration, or our summary of its calls. */
  origin: "reasoning" | "narration" | "summary";
  /** The reasoning under a reasoning title. */
  detail: string;
  /**
   * Codex's reasoning titles that are not phases of their own: the ones inside a narrated phase, and the ones that
   * led to a titled phase without a call between them.
   */
  thoughts: Thought[];
  /** The narration a phase opened with, when it says more than its title. */
  narration: Block | null;
  sections: WorkSection[];
  /** Calls that keep their own rendering inside the phase, such as messages to another thread. */
  extras: Block[];
  /** Every block the phase covers, the source included. */
  blocks: Block[];
  source: Block | null;
}

export interface Thought {
  title: string;
  body: string;
}

export interface WorkSection {
  id: string;
  label: string;
  chips: WorkChip[];
  /** The calls behind the section, with the reasoning that led to them, for the full list. */
  blocks: Block[];
}

export interface PlanItem {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

/** Tool attempts share one summary, including failures; their original status stays in the expanded details. */
export function foldable(block: Block, taskCards: boolean): boolean {
  // Collaboration milestones are individually meaningful in the work timeline.
  if (block.kind === "tool" && /(?:spawn_agent|thread_send|send_message|team_say|team_complete)$/.test(block.name)) return false;
  if (block.kind === "activity" && /finished|completed/i.test(block.label)) return false;
  if (block.kind === "thinking") return !block.status || block.status === "success" || block.status === "running";
  if (block.kind === "tool") return (!block.status || ["running", "success", "error"].includes(block.status)) && !(taskCards && toolShowsCard(block));
  if (block.kind === "activity") return ["running", "success"].includes(block.status) && !isImageGeneration(block) && !isImageView(block);
  return false;
}

/** Still happening: a call without its result, reasoning or a reply still streaming, an activity still running. */
export function isLive(block: Block): boolean {
  if (block.kind === "tool") return !block.done;
  if (block.kind === "thinking") return block.endedAt === null;
  if (block.kind === "activity") return block.status === "running";
  return block.kind === "message" && block.streaming;
}

/**
 * Waiting on the provider's next response, or on its process starting. Worth a word while it lasts and nothing
 * once it is over: every request Claude makes opens one of these.
 */
export function isSignal(block: Block): boolean {
  return block.kind === "activity" && block.status !== "error" && (block.id.startsWith("activity-request-") || /^Starting /.test(block.label));
}

/** "**Inspecting the status row**\n\nI need to…": a titled section per bold heading, in Codex's summary format. */
export function reasoningSections(text: string): { title: string; body: string }[] {
  const sections: { title: string; body: string }[] = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    const [first = "", ...rest] = paragraph.trim().split("\n");
    const heading = /^\*\*(.+?)\*\*$/.exec(first.trim());
    const last = sections[sections.length - 1];
    if (heading) sections.push({ title: heading[1]!.trim(), body: rest.join("\n").trim() });
    else if (last && paragraph.trim()) last.body = [last.body, paragraph.trim()].filter(Boolean).join("\n\n");
  }
  return sections;
}

const CUE = /^(now|next|then|first)\b,?\s*/i;
/** A later sentence that says what comes next. */
const AHEAD = /^(now|next|then|first|i['’]ll|i will|let me|let['’]s|i['’]m going to)\b/i;
/** Words that only announce the speaker: "Let me look at the comp" titles as "Look at the comp". */
const FILLER = /^(let me|let['’]s|i['’]ll start by|i will start by|i['’]ll|i will|i['’]m going to|i am going to|i['’]m|i am)\s+/i;
/** A sentence that opens on what the agent is doing: "Checking the ledger", not "Nothing changed". */
const DOING = /^(?!(?:nothing|something|everything|anything|during|thing|string|morning|evening)\b)[a-z]+ing\b/i;

/**
 * The sentence of a narration that says what comes next. "The core keeps it running. Checking the ledger." reads as
 * "Checking the ledger": a later sentence that opens with Now, Next, I'll or Let me, or with what it is doing, wins;
 * then the second sentence after a short status like "Found it."; then the first.
 */
export function narrationTitle(text: string): string {
  const plain = text
    .replace(/[*_`#>]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = plain.split(/(?<=[.!?])\s+(?=[A-Z"'(])/).filter(Boolean);
  const [first = plain, second] = sentences;
  const later = sentences.slice(1).find((sentence) => AHEAD.test(sentence) || DOING.test(sentence));
  const chosen = later ?? (second && first.split(" ").length <= 4 ? second : first);
  return chosen
    .replace(CUE, "")
    .replace(FILLER, "")
    .replace(/[.:;,]+$/, "")
    .replace(/^./, (c) => c.toUpperCase());
}

/** Codex posts its plan as "status: step" lines; Claude Code as a todo list. */
export function planItems(block: Block): PlanItem[] {
  const valid = (status: unknown): status is PlanItem["status"] => status === "pending" || status === "in_progress" || status === "completed";
  if (block.kind === "tool" && /^todowrite$/i.test(block.name)) {
    const todos = (block.input as { todos?: unknown } | null)?.todos;
    if (!Array.isArray(todos)) return [];
    return todos.flatMap((todo: { content?: unknown; status?: unknown }) => (typeof todo?.content === "string" && valid(todo.status) ? [{ text: todo.content, status: todo.status }] : []));
  }
  if (block.kind !== "activity" || block.label !== "Plan") return [];
  return block.text.split("\n").flatMap((line) => {
    const match = /^(\w+): (.+)$/.exec(line.trim());
    return match && valid(match[1]) ? [{ status: match[1], text: match[2]! }] : [];
  });
}

/** "Read 3 files", "Ran 2 commands": a phase's name when the agent gave it none, from what it did. */
function summaryTitle(phase: WorkPhase): string {
  const intents = phase.sections.flatMap((section) => section.chips.filter((chip) => chip.kind === "intent" || chip.kind === "agent"));
  if (intents.length === 1 && phase.sections.length === 1) return intents[0]!.label;
  const count = (label: string) => phase.sections.find((section) => section.label === label)?.chips.length ?? 0;
  const parts: [number, string, (n: number) => string][] = [
    [count("Edited"), "Edited a file", (n) => `Edited ${n} files`],
    [count("Read"), "Read a file", (n) => `Read ${n} files`],
    [count("Searched"), "Searched once", (n) => `Searched ${n} times`],
    [count("Ran"), "Ran a command", (n) => `Ran ${n} commands`],
  ];
  const words = parts.filter(([n]) => n > 0).map(([n, one, many]) => (n === 1 ? one : many(n)));
  const [head = "Worked", ...rest] = (words.length ? words : phase.sections.map((section) => section.label)).slice(0, 2);
  return [head, ...rest.map((word) => word.charAt(0).toLowerCase() + word.slice(1))].join(", ");
}

function openPhase(id: string, title: string, origin: WorkPhase["origin"], source: Block | null, extra: Partial<WorkPhase> = {}): WorkPhase {
  return { id, title, origin, detail: "", thoughts: [], narration: null, sections: [], extras: [], blocks: source ? [source] : [], source, ...extra };
}

/** Files a call under its sections. `lead` is untitled reasoning that came before it and opens its section's list. */
function addCall(phase: WorkPhase, block: Block, lead: Block[]) {
  phase.blocks.push(...lead, block);
  callParts(block).forEach((part, index) => {
    let section = phase.sections.find((candidate) => candidate.label === part.section);
    if (!section) {
      section = { id: `${phase.id}:${part.section}`, label: part.section, chips: [], blocks: [] };
      phase.sections.push(section);
    }
    if (index === 0) section.blocks.push(...lead, block);
    if (part.chip) addChip(section, part.chip, block);
  });
}

/** The same file or query twice is one chip; an edit's lines add up across calls. */
function addChip(section: WorkSection, part: Omit<WorkChip, "blocks">, block: Block) {
  const chip = section.chips.find((candidate) => candidate.key === part.key);
  if (!chip) {
    section.chips.push({ ...part, blocks: [block] });
    return;
  }
  chip.blocks.push(block);
  if (part.added !== undefined) chip.added = (chip.added ?? 0) + part.added;
  if (part.removed !== undefined) chip.removed = (chip.removed ?? 0) + part.removed;
}

type Kind = "signal" | "reasoning" | "narration" | "plan" | "action" | "pinned" | "block";

function classify(block: Block, taskCards: boolean, pinned: string | undefined): Kind {
  if (block.id === pinned) return "pinned";
  if (isSignal(block)) return "signal";
  if (block.kind === "message") return block.role === "assistant" && block.text.trim() ? "narration" : "block";
  if (planItems(block).length) return "plan";
  if (!foldable(block, taskCards)) return "block";
  return block.kind === "thinking" ? "reasoning" : "action";
}

/** Untitled reasoning with something to read stays reachable on its own; empty reasoning has nothing to show. */
const readable = (blocks: Block[]) => blocks.filter((block) => block.kind === "thinking" && block.text.trim());

/** Activities alone, such as compacting or a hook, already have their own rows; a phase around them would only repeat them. */
function bare(phase: WorkPhase): boolean {
  return !phase.extras.length && phase.sections.every((section) => !section.chips.length) && phase.blocks.every((block) => block.kind === "activity" || block.kind === "thinking");
}

/** Builds the turn's entries in order; phases close when the agent starts the next one or something else intervenes. */
class EntryBuilder {
  readonly entries: WorkEntry[] = [];
  private phase: WorkPhase | null = null;
  private lead: Block[] = [];

  standalone(items: Block[]) {
    const last = this.entries[this.entries.length - 1];
    if (!items.length) return;
    if (last?.kind === "blocks") last.blocks.push(...items);
    else this.entries.push({ kind: "blocks", id: `blocks-${items[0]!.id}`, blocks: [...items] });
  }

  private start(phase: WorkPhase) {
    this.flushLead();
    this.phase = phase;
    this.entries.push({ kind: "phase", phase });
  }

  private flushLead() {
    this.standalone(readable(this.lead));
    this.lead = [];
  }

  reasoning(block: Extract<Block, { kind: "thinking" }>) {
    const sections = reasoningSections(block.text);
    if (!sections.length) {
      // Untitled reasoning still under way is the live line's "Thinking", not a row.
      if (!isLive(block)) this.lead.push(block);
      return;
    }
    const lead = this.lead;
    this.lead = [];
    // Narration names the phase; Codex's reasoning titles inside it are the steps it took on the way.
    if (this.phase?.origin === "narration") {
      this.phase.thoughts.push(...sections);
      this.phase.blocks.push(...lead, block);
      return;
    }
    // Titles that led to no call yet fold into the next one, which carries them as the steps that led there.
    const previous = this.phase?.origin === "reasoning" && !this.phase.sections.length && !this.phase.extras.length ? this.phase : null;
    if (previous) this.entries.pop();
    const steps = [...(previous ? [...previous.thoughts, { title: previous.title, body: previous.detail }] : []), ...sections];
    const last = steps.pop()!;
    this.start(openPhase(`phase-${block.id}`, last.title, "reasoning", block, { detail: last.body, thoughts: steps }));
    this.phase!.blocks.unshift(...(previous?.blocks ?? []), ...lead);
  }

  narration(block: Extract<Block, { kind: "message" }>) {
    const title = narrationTitle(block.text);
    const more = block.text.replace(/[*_`#>\s]/g, "").length > title.replace(/\s/g, "").length + 12;
    this.start(openPhase(`phase-${block.id}`, title, "narration", block, { narration: more ? block : null }));
  }

  action(block: Block) {
    // The reasoning that led to this call goes with it, even when the call is what opens the phase.
    const lead = this.lead;
    this.lead = [];
    if (!this.phase) this.start(openPhase(`phase-${block.id}`, "", "summary", null));
    addCall(this.phase!, block, lead);
  }

  other(block: Block, kind: Kind) {
    // A milestone inside a phase belongs to it; a pinned block stays in view on its own.
    if (kind === "block" && this.phase && block.kind !== "message") {
      this.phase.extras.push(block);
      this.phase.blocks.push(block);
      return;
    }
    this.phase = null;
    this.flushLead();
    if (kind === "plan") this.entries.push({ kind: "plan", id: block.id, block, items: planItems(block) });
    else this.standalone([block]);
  }

  finish(blocks: Block[]): WorkEntry[] {
    this.flushLead();
    this.entries.forEach((entry, index) => {
      if (entry.kind !== "phase" || entry.phase.origin !== "summary") return;
      if (bare(entry.phase))
        this.entries[index] = { kind: "blocks", id: `blocks-${entry.phase.id}`, blocks: entry.phase.blocks.filter((block) => block.kind === "activity" || readable([block]).length) };
      else entry.phase.title = summaryTitle(entry.phase);
    });
    // A turn that only started, or only thought, still says so once it has.
    if (!this.entries.length) this.standalone(blocks.filter((block) => (isSignal(block) || block.kind === "thinking") && !isLive(block)));
    return this.entries;
  }
}

/** The turn's work as phases, plans and blocks that keep their own rendering, in the order they happened. */
export function workEntries(blocks: Block[], taskCards = true, pinned?: string): WorkEntry[] {
  const builder = new EntryBuilder();
  for (const block of blocks) {
    const kind = classify(block, taskCards, pinned);
    if (kind === "signal") continue;
    if (kind === "reasoning" && block.kind === "thinking") builder.reasoning(block);
    else if (kind === "narration" && block.kind === "message") builder.narration(block);
    else if (kind === "action") builder.action(block);
    else builder.other(block, kind);
  }
  return builder.finish(blocks);
}

export interface LiveHeadline {
  label: string;
  since: number | undefined;
  /** The phase already showing this, when the work list has one. */
  entryId: string | null;
}

const progressive: Record<string, string> = {
  Read: "Reading",
  Searched: "Searching",
  Listed: "Listing",
  Edited: "Editing",
  Ran: "Running",
  Fetched: "Fetching",
  Delegated: "Delegating",
  "Searched the web": "Searching the web",
  "Searched memory": "Searching memory",
};

/** A section's label while one of its calls runs: "Reading", "Using Figma". */
export function liveSectionLabel(label: string): string {
  return progressive[label] ?? label.replace(/^Used /, "Using ");
}

/**
 * What a phase says while it runs: the agent's title, or for a summary phase the call under way ("Running pnpm test").
 * Between calls a summary phase keeps naming the last one, so the words hold still until the next begins.
 */
function phaseHeadline(phase: WorkPhase, block: Block | undefined): LiveHeadline {
  if (phase.origin !== "summary") {
    const since = phase.source?.kind === "thinking" ? phase.source.startedAt : phase.source?.at;
    // Inside a narrated phase, Codex's latest reasoning title says what it is on right now.
    const step = phase.origin === "narration" ? phase.thoughts[phase.thoughts.length - 1]?.title : undefined;
    return { label: step ?? phase.title, since, entryId: phase.id };
  }
  const call = block && phase.blocks.includes(block) ? block : phase.blocks.findLast((candidate) => candidate.kind === "tool" || candidate.kind === "activity");
  const section = phase.sections.find((candidate) => call && candidate.blocks.includes(call));
  const chip = section?.chips.find((candidate) => call && candidate.blocks.includes(call));
  if (chip?.kind === "intent" || chip?.kind === "agent") return { label: chip.label, since: call?.at, entryId: phase.id };
  const verb = section ? liveSectionLabel(section.label) : "Working";
  return { label: chip ? `${verb} ${chip.label}` : verb, since: call?.at, entryId: phase.id };
}

function holder(entries: WorkEntry[], current: Block): LiveHeadline | null {
  for (const entry of entries) {
    // A row that keeps its own rendering shows its own live state.
    if (entry.kind === "blocks" && entry.blocks.includes(current) && current.kind === "activity") return { label: current.label, since: current.at, entryId: entry.id };
    if (entry.kind !== "phase") continue;
    const { phase } = entry;
    if (phase.blocks.includes(current)) return phaseHeadline(phase, current);
  }
  return null;
}

/**
 * The one thing the turn is doing now, for the line that carries it. Null while text streams: the words arriving
 * say it already. `turn` is every block of the turn, since a streaming reply sits outside the work. Between calls,
 * while Claude waits on its next response or thinks, the newest phase is still the work under way and keeps the
 * line, so nothing folds and reopens on every call.
 */
export function liveHeadline(entries: WorkEntry[], turn: Block[]): LiveHeadline | null {
  const current = turn.findLast(isLive);
  if (current?.kind === "message") return null;
  const held = current ? holder(entries, current) : null;
  if (held) return held;
  const gap = gapWords(current);
  const last = entries[entries.length - 1];
  if (last?.kind !== "phase") return { label: gap?.label ?? "Working", since: gap?.since, entryId: null };
  // A phase the agent named keeps its title; one named after its calls says what fills the gap.
  const headline = phaseHeadline(last.phase, undefined);
  return gap && last.phase.origin === "summary" ? { ...headline, ...gap } : headline;
}

/** "Thinking", or "Waiting for Claude": what the agent is doing between calls, when it says. */
function gapWords(current: Block | undefined): { label: string; since: number | undefined } | null {
  if (current?.kind === "thinking") return { label: "Thinking", since: current.startedAt };
  if (current?.kind === "activity") return { label: current.label, since: current.at };
  return null;
}
