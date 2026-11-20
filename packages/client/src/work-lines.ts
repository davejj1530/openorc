import { commandWords } from "./command-words.js";
import { hitTerms } from "./search-results.js";
import { toolCallPresentation, type ToolIconName } from "./tool-presentation.js";
import { toolResult } from "./tool-result.js";
import type { Block } from "./transcript.js";
import { isRoutine, liveSectionLabel, reasoningSections, standsAlone, type LiveHeadline, type WorkPhase } from "./work-steps.js";
import type { WorkChip } from "./work-chips.js";
import type { CommandObject, TestsObject, WorkObject } from "./work-objects.js";
import { objectOutcome, objectsTitle } from "./work-outcomes.js";

/**
 * A step's work as lines. Everything a step did is one line each: a mark, what was done and to what, and how it came
 * out. This is the reading both apps draw: which things share a line, what each line is called, and what stands at
 * its end. Each app only draws the line and what it opens to.
 */

type ToolBlock = Extract<Block, { kind: "tool" }>;
type Run = CommandObject | TestsObject;

/** One line of a step: a thing it did, and how many times in a row it did the same. */
export interface ActLine {
  object: WorkObject;
  times: number;
  /** Things done back to back that fold into this one line and open to each; empty for a line of one thing. */
  group: ActLine[];
}

/** The call a thing's line and screen read: its last one. */
export const lineCall = (object: WorkObject) => object.blocks.findLast((block): block is ToolBlock => block.kind === "tool");

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** A folded step's work, counted: "read 3 files, 6 searches, ran 2 commands". */
export function stepCounts(objects: WorkObject[]): string {
  const count = (test: (object: WorkObject) => boolean) => objects.filter(test).length;
  const files = objects.reduce((sum, object) => sum + (object.kind === "read" ? object.rows.length : 0), 0);
  const searches = count((object) => object.kind === "search" || object.kind === "web");
  const commands = count((object) => object.kind === "command" && object.state !== "failed");
  const pages = count((object) => object.kind === "fetch");
  const tools = count((object) => object.kind === "tool");
  const edits = count((object) => object.kind === "edit" && !object.chip.path);
  return [
    edits ? `edited ${plural(edits, "file")}` : "",
    files ? `read ${plural(files, "file")}` : "",
    searches ? plural(searches, "search", "searches") : "",
    commands ? `ran ${plural(commands, "command")}` : "",
    pages ? `read ${plural(pages, "page")}` : "",
    tools ? `used ${plural(tools, "tool")}` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/* ------------------------------------------------------------------ What a line is called */

/** The words a pattern looks for, without the marks that make it a pattern: `(open|close)` is open and close. */
function plainTerms(term: string): string[] {
  return (
    term
      .replace(/^["']+|["']+$/g, "")
      .replace(/^\(|\)$/g, "")
      .split("|")
      // An escaped mark is that mark; an escaped letter is a class of the pattern and stays as written.
      .map((part) => part.replace(/\\([^A-Za-z0-9])/g, "$1").trim())
      .filter(Boolean)
  );
}

/** What a search looked for, first term first. */
const searchTerms = (chip: WorkChip) => hitTerms(chip).flatMap(plainTerms);

/** A search by its first term as a quote: “onClose”. */
function searchWord(chip: WorkChip): string {
  return `“${searchTerms(chip)[0] ?? chip.label}”`;
}

/** A search by its first term, and how many more it looked for: “onClose” +2. */
function searched(chip: WorkChip): string {
  const more = searchTerms(chip).length - 1 + Number(/and (\d+) more/.exec(chip.label)?.[1] ?? 0);
  return `${searchWord(chip)}${more > 0 ? ` +${more}` : ""}`;
}

/** A picture the reader sent is kept under a generated name, which says nothing. */
const SENT_IMAGE = /attachments\/[0-9a-f-]{36}\.(png|jpe?g|gif|webp)$/i;
const rowName = (row: WorkChip | undefined) => (row?.path && SENT_IMAGE.test(row.path) ? "your image" : row?.label);

function readName(rows: Extract<WorkObject, { kind: "read" }>["rows"]): string {
  if (!rows.length) return "a file";
  const [first, second, ...rest] = rows;
  const named = [rowName(first), rowName(second)].filter(Boolean).join(", ");
  return rest.length ? `${named} and ${rest.length} more` : named;
}

/** A tool's call by its name and what it was asked: explore “who calls describe”. One that has not said yet has no name of its own. */
function toolName({ chip, section, named }: Extract<WorkObject, { kind: "tool" }>): string {
  // One of OpenOrc's own tools names what it was about once its answer says: the thread it read.
  if (named) return named;
  if (chip.label === section) return "";
  const asked = chip.title.split(" · ")[1];
  return asked ? `${chip.label} “${asked}”` : chip.label;
}

/** What the line calls the thing: the file, what was searched for, what a command was for. */
function actName(object: WorkObject): string {
  switch (object.kind) {
    case "read":
      return readName(object.rows);
    case "search":
      return searched(object.chip);
    case "web":
      return `“${object.chip.label}”`;
    case "git":
      return object.pullRequest?.number ? `#${object.pullRequest.number}` : (object.branch ?? "the branch");
    case "command":
      // A command still being written has no text yet: the line says so, and reads as a command once it is done.
      if (object.chip.kind === "tool") return object.state === "running" ? "Writing a command" : "Command";
      return object.chip.kind === "command" ? commandWords(object.chip.label).command : object.chip.label;
    case "edit":
      return object.chip.path ? object.chip.label : "a file";
    case "tool":
      return toolName(object);
    default:
      return object.chip.label;
  }
}

/** What was done to each kind of object, as its finished verb. */
const doneVerbs: { [K in WorkObject["kind"]]: (object: Extract<WorkObject, { kind: K }>) => string } = {
  git: (git) => {
    if (git.pullRequest) return git.pullRequest.state === "running" ? "Opening" : "Opened";
    if (git.push) return git.push.state === "running" ? "Pushing" : "Pushed";
    return "Committed";
  },
  tests: (tests) => (tests.state === "running" ? "Testing" : "Tested"),
  edit: (edit) => (edit.created ? "Wrote" : "Edited"),
  // A read that has only begun names nothing yet, and is a read until it says otherwise.
  read: (read) => (read.rows.length > 0 && read.rows.every((row) => row.kind === "folder") ? "Listed" : "Read"),
  search: () => "Searched",
  web: () => "Searched",
  fetch: () => "Read",
  command: () => "Ran",
  // "Used Mobbin" reads as whose tool it is, Mobbin; "Used skill" is already what was done.
  tool: (tool) => tool.section.replace(/^Used (?=[A-Z])/, ""),
};

/** The verb for a thing: what was done to it, or what is being done while it runs. */
export function objectVerb(object: WorkObject): string {
  const verb = (doneVerbs[object.kind] as (object: WorkObject) => string)(object);
  return object.state === "running" ? liveSectionLabel(verb) : verb;
}

/* ------------------------------------------------------------------ Which things share a line */

const sum = (a: number | undefined, b: number | undefined) => (a ?? 0) + (b ?? 0);

/** Two edits of one file as one: its sizes added up and the lines of both. */
function editedAgain(known: Extract<WorkObject, { kind: "edit" }>, next: Extract<WorkObject, { kind: "edit" }>): WorkObject {
  const chip = { ...next.chip, added: sum(known.chip.added, next.chip.added), removed: sum(known.chip.removed, next.chip.removed) };
  return { ...next, id: known.id, chip, created: known.created, lines: [...known.lines, ...next.lines], blocks: [...known.blocks, ...next.blocks] };
}

/**
 * A call still running is one line, its command. What it searches and reads on the way is told once it is done:
 * until then those would be lines with nothing to show but a spinner each.
 */
function underWay(objects: WorkObject[]): WorkObject[] {
  const calls = new Map<string, WorkObject[]>();
  for (const object of objects) {
    const call = object.state === "running" ? lineCall(object) : undefined;
    if (call) calls.set(call.id, [...(calls.get(call.id) ?? []), object]);
  }
  const dropped = new Set<WorkObject>();
  for (const parts of calls.values()) {
    const kept = parts.find((part) => part.kind === "command" || part.kind === "tests") ?? parts[0]!;
    for (const part of parts) if (part !== kept) dropped.add(part);
  }
  return dropped.size ? objects.filter((object) => !dropped.has(object)) : objects;
}

/** Whether a line belongs with the one before it: a search after a search, or one tool called again to the same words. */
function foldsInto(last: ActLine | undefined, { object }: ActLine): boolean {
  if (!last || last.object.kind !== object.kind) return false;
  if (object.kind === "search") return true;
  return object.kind === "tool" && objectVerb(last.object) === objectVerb(object) && actName(last.object) === actName(object);
}

/** Searches done back to back are one line, which opens to each of them; so are calls of one tool that read the same. */
function folded(lines: ActLine[]): ActLine[] {
  const out: ActLine[] = [];
  for (const line of lines) {
    const last = out[out.length - 1];
    if (last && foldsInto(last, line)) out[out.length - 1] = { ...last, group: [...(last.group.length ? last.group : [last]), line] };
    else out.push(line);
  }
  return out;
}

/**
 * A step's things as lines. Things done back to back that would read as the same line are one: a search run again
 * shows its latest run, and a file edited three times shows the three as one change.
 */
export function actLines(objects: WorkObject[]): ActLine[] {
  const lines: ActLine[] = [];
  for (const object of underWay(objects)) {
    const last = lines[lines.length - 1];
    // A run that failed and its retry are two lines: each keeps its place in time.
    // A tool's calls each keep what they were asked and gave back, so they fold into a line that opens to them all.
    const merges = object.kind !== "read" && object.kind !== "git" && object.kind !== "tool";
    const same = merges && last && last.object.kind === object.kind && last.object.state === object.state && actName(last.object) === actName(object);
    if (!same) lines.push({ object, times: 1, group: [] });
    else if (last.object.kind === "edit" && object.kind === "edit") lines[lines.length - 1] = { object: editedAgain(last.object, object), times: last.times + 1, group: [] };
    else lines[lines.length - 1] = { object: { ...object, id: last.object.id }, times: last.times + 1, group: [] };
  }
  return folded(lines);
}

/** A folded line's searches by their first terms: “brain”, “cloud” and 9 more. A tool's calls read alike, so as any one of them. */
function groupName(group: ActLine[]): string {
  if (group[0]?.object.kind !== "search") return group[0] ? actName(group[0].object) : "";
  // Two searches for one word read as that word once.
  const [first, second, ...rest] = [...new Set(group.map(({ object }) => (object.kind === "search" ? searchWord(object.chip) : "")))];
  if (!second) return first ?? "";
  return rest.length ? `${first}, ${second} and ${rest.length} more` : `${first}, ${second}`;
}

/* ------------------------------------------------------------------ What a line says */

/** Where a line stands: a folded line is as far along as its newest. */
export const lineState = ({ object, group }: ActLine) => (group.length ? group[group.length - 1]!.object.state : object.state);

/** A command or test run named in the agent's words, or by plain words for what it ran, needs no verb before it. */
const worded = (object: WorkObject) => (object.kind === "command" || object.kind === "tests") && object.chip.kind !== "command";

/** A line's words: the quiet verb, when the name does not already say it, and the thing in ink. `code`: a command shown as written. */
export interface LineWords {
  verb: string | null;
  name: string;
  code: boolean;
}

export function lineWords({ object, group }: ActLine): LineWords {
  const verb = objectVerb(object);
  const said = `${verb.charAt(0).toUpperCase()}${verb.slice(1)}`;
  const name = group.length ? groupName(group) : actName(object);
  return { verb: worded(object) || !name ? null : said, name: name || said, code: object.kind === "command" && object.chip.kind === "command" };
}

/** What a line's mark is of: a branch, a run, a tool by its own icon, a file or search by its chip, or a file not yet named. */
export type LineMark = { kind: "git" } | { kind: "run" } | { kind: "tool"; icon: ToolIconName } | { kind: "chip"; chip: WorkChip } | { kind: "unnamed" };

export function lineMark(object: WorkObject): LineMark {
  if (object.kind === "git") return { kind: "git" };
  // A command is a command from its first moment, before its text says so.
  if (object.kind === "command" || object.kind === "tests") return { kind: "run" };
  if (object.kind === "tool") {
    // A tool takes the mark of what it does: a message, a page, a lookup.
    const call = lineCall(object);
    return { kind: "tool", icon: call ? toolCallPresentation(call.name, call.input).icon : "Hammer" };
  }
  if (object.kind !== "read") return { kind: "chip", chip: object.chip };
  // A read that has only begun names no file yet.
  const [row] = object.rows;
  return row ? { kind: "chip", chip: row } : { kind: "unnamed" };
}

type Look = Extract<WorkObject, { kind: "read" | "search" | "web" }>;

/** How many a search found, in what it printed: matching lines, or files when it listed them. */
export function foundCount(count: number, listed: boolean): string {
  if (count === 0) return "No matches";
  const thing = listed ? "file" : "match";
  return count === 1 ? `1 ${thing}` : `${count} ${thing}${listed ? "s" : "es"}`;
}

/** What looking came to, in words: the lines of one file read, what a search found, how many pages the web gave. */
function found(look: Look): string | null {
  if (look.kind === "search") {
    const listed = look.hits.every((hit) => hit.line === null);
    return look.matches === null ? null : foundCount(look.matches, listed);
  }
  if (look.kind === "read") return look.rows.length === 1 ? (look.rows[0]!.note ?? null) : null;
  if (!look.links.length) return null;
  return look.links.length === 1 ? "1 result" : `${look.links.length} results`;
}

/** "Running for 90s": how long a command under way says it has been going, when it does. */
function runningFor(object: WorkObject): string | null {
  if (object.kind !== "command" && object.kind !== "tests") return null;
  const progress = lineCall(object)?.progress;
  return progress && /^Running for /.test(progress) ? progress.replace(/^Running for /, "") : null;
}

/**
 * How a line came out, at its end: still going (and for how long, when it says), an edit's size, or a few words such
 * as what a search found or a run came to. Null for a line with nothing to add.
 */
export type LineResult = { kind: "running"; since: string | null } | { kind: "edit"; created: boolean; added: number; removed: number } | { kind: "words"; text: string; bad: boolean } | null;

function objectResult(object: WorkObject): LineResult {
  if (object.state === "running") return { kind: "running", since: runningFor(object) };
  if (object.kind === "edit") return { kind: "edit", created: object.created, added: object.chip.added ?? 0, removed: object.chip.removed ?? 0 };
  if (object.kind === "read" && object.state === "failed") return { kind: "words", text: "Failed", bad: true };
  if (object.kind === "read" || object.kind === "search" || object.kind === "web") {
    const words = found(object);
    return words ? { kind: "words", text: words, bad: false } : null;
  }
  const outcome = objectOutcome(object);
  if (!outcome) return null;
  return { kind: "words", text: object.kind === "git" ? unsaid(outcome.text, object) : outcome.text, bad: outcome.failed };
}

/** A Git outcome without the verb its line already leads with: "Committed main" ends on the commit, not on "Committed" again. */
function unsaid(outcome: string, git: Extract<WorkObject, { kind: "git" }>): string {
  const verb = `${doneVerbs.git(git)} `;
  return outcome.startsWith(verb) ? outcome.slice(verb.length) : outcome;
}

/** A line's end: how many times it did the same, when more than once, and how it came out. A folded line says how many it holds. */
export function lineEnd(line: ActLine): { times: string | null; result: LineResult } {
  const { object, times, group } = line;
  const repeated = times > 1 && object.kind !== "edit" ? `${times} times` : null;
  if (!group.length) return { times: repeated, result: objectResult(object) };
  if (lineState(line) === "running") return { times: repeated, result: { kind: "running", since: null } };
  return { times: repeated, result: { kind: "words", text: `${group.length} ${object.kind === "search" ? "searches" : "times"}`, bad: false } };
}

/* ------------------------------------------------------------------ What a line opens to */

/** What a run has printed so far, or the last lines kept for it. How long it has run is its line's to say, not its screen's. */
export function printedBy(object: Run, call: ToolBlock): string {
  const result = call.output === undefined || call.output === null ? "" : toolResult(call.output).text;
  return result || (object.kind === "command" ? object.tail.join("\n") : "");
}

/** Whether a run has anything to draw yet: the command it was given, or something it printed. */
function ran(object: Run): boolean {
  const call = lineCall(object);
  if (!call) return false;
  return Boolean(toolCallPresentation(call.name, call.input).object.trim() || printedBy(object, call).trim());
}

/** Whether the thing has something to show when its line is opened. */
export function lineOpens(object: WorkObject): boolean {
  switch (object.kind) {
    case "read":
      return object.rows.length > 1 || object.state === "failed";
    case "search":
      return object.hits.length > 0;
    case "edit":
      return object.lines.length > 0;
    case "web":
      return object.links.length > 0;
    case "fetch":
      return Boolean(object.excerpt);
    case "command":
      return ran(object);
    case "tests":
      return object.run !== null || ran(object);
    default:
      return true;
  }
}

/** The file a line is about when it read just the one, which the line is then the way to. */
export function lineFile(object: WorkObject): WorkChip | null {
  if (object.kind !== "read" || object.state === "failed" || object.rows.length !== 1) return null;
  const [row] = object.rows;
  return row!.kind === "file" && row!.path ? row! : null;
}

/* ------------------------------------------------------------------ A step */

/** A step's name. One named after its calls takes its Git work's words when those say it better. */
export const stepTitle = (phase: WorkPhase, objects: WorkObject[]): string => (phase.origin === "summary" ? objectsTitle(objects) : null) ?? phase.title;

/** A step's lines. A milestone that draws as itself, such as a card or a picture, keeps its own row; any other is a line in its place. */
export function stepLines(phase: WorkPhase, objects: WorkObject[]): ActLine[] {
  return actLines(objects.filter((object) => !object.blocks.every((block) => phase.extras.includes(block) && standsAlone(block))));
}

/**
 * What a step shows beside its lines, as rows of their own: its activities with nothing to list, apart from the
 * routine ones, or all it holds when it did nothing to line up; then the milestones that draw as themselves.
 */
export function stepRows(phase: WorkPhase, objects: WorkObject[]): { rows: Block[]; alone: Block[] } {
  const quiet = phase.sections.flatMap((group) => (group.chips.length ? [] : group.blocks.filter((block) => block.kind === "activity" && !isRoutine(block))));
  return { rows: objects.length ? quiet : phase.sections.flatMap((group) => group.blocks), alone: phase.extras.filter(standsAlone) };
}

/**
 * What fills a wait while a step runs, such as "Thinking". Nothing while one of its calls is under way: that call's
 * own line says it already, as the step's name does when the words are its own.
 */
export function stepWaiting(headline: LiveHeadline | null, title: string, objects: WorkObject[]): LiveHeadline | null {
  if (!headline || (headline.label === title && !headline.thought)) return null;
  return objects.some((object) => object.state === "running") ? null : headline;
}

/** A step's thoughts that have words: the ones the agent titled, the untitled ones in full, and how long they took together. */
export interface StepThoughts {
  titled: WorkPhase["thoughts"];
  texts: string[];
  took: number;
}

export function stepThoughts(phase: WorkPhase): StepThoughts {
  const blocks = phase.blocks.filter((block): block is Extract<Block, { kind: "thinking" }> => block.kind === "thinking");
  const texts = blocks.filter((block) => block.text.trim() && !reasoningSections(block.text).length).map((block) => block.text.trim());
  const took = blocks.reduce((total, block) => total + (block.endedAt === null ? 0 : block.endedAt - block.startedAt), 0);
  return { titled: phase.thoughts, texts, took };
}

/** The first thing a step thought, in its own words: a thought's title, or the opening sentence of one without. */
export function firstThought({ titled, texts }: StepThoughts): string {
  const said = titled[0]?.title ?? texts[0]?.split(/(?<=[.!?])\s+/)[0] ?? "";
  return said.replace(/\s+/g, " ").replace(/\.$/, "");
}
