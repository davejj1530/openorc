import { toolDigest, type GitPushed, type TestRun, type ToolDigest, type WebLink } from "@openorc/protocol";
import { readCommand } from "./command-reader.js";
import type { RunDomain } from "./run-labels.js";
import { commandLine, shellSteps, unwrapShell } from "./shell.js";
import { toolCallPresentation } from "./tool-presentation.js";
import { joinPath } from "./tool-view.js";
import type { Block } from "./transcript.js";
import { callParts, changeKind, commandText, patchSections, type CallPart, type WorkChip } from "./work-chips.js";

/**
 * A phase's calls as the things they worked on, each in its own terms: the branch a commit and push published and
 * the pull request it opened, a test run with its cases, an edit with its lines, a search with what it found. Reads
 * in a row are one object; a phase's Git calls are one branch. The chips of `work-chips` say what each call touched
 * across every agent's shapes; this adds what came back, from the output or the digest the core kept of it.
 */
export type WorkObject = ReadObject | SearchObject | EditObject | TestsObject | GitObject | CommandObject | WebObject | FetchObject | ToolObject;

export type ObjectState = "running" | "done" | "failed" | "stopped";

interface Common {
  id: string;
  state: ObjectState;
  /** The calls behind it, which open as they always did. */
  blocks: Block[];
}

export interface ReadObject extends Common {
  kind: "read";
  /** Files read and folders listed, in the order the calls came. */
  rows: WorkChip[];
}

export interface SearchHit {
  path: string;
  line: number | null;
  text: string;
}

export interface SearchObject extends Common {
  kind: "search";
  chip: WorkChip;
  /** The first lines it found; empty when it printed something else, or nothing. */
  hits: SearchHit[];
  /** How many lines it found, when every printed line was one. */
  matches: number | null;
}

export interface EditLine {
  sign: "+" | "-";
  text: string;
}

export interface EditObject extends Common {
  kind: "edit";
  chip: WorkChip;
  /** The call made the file rather than changing one. */
  created: boolean;
  /** A few of the lines it removed and added, in that order. */
  lines: EditLine[];
}

export interface TestsObject extends Common {
  kind: "tests";
  chip: WorkChip;
  /** What the runner printed so far; null while it has printed nothing it can read, or when it never ran. */
  run: TestRun | null;
  /** How many cases the same command ran earlier in the turn, so a live run knows how far it has to go. */
  expected: number | null;
}

export interface MadeCommit {
  sha: string;
  subject: string;
  at: number | undefined;
}

export interface PushWork {
  state: ObjectState;
  /** The remote's name as the command gave it. */
  remote: string;
  /** What it sent: "89a9ed1..4f2a9c1", or a new branch. Null until the push has said. */
  ref: GitPushed | null;
  /** How far the push has written its objects, 0 to 1, while it runs. */
  progress: number | null;
  /** "18/28", the objects written so far. */
  objects: string | null;
}

export interface PullRequestWork {
  state: ObjectState;
  number: number | null;
  url: string | null;
  title: string | null;
  base: string | null;
}

export interface GitObject extends Common {
  kind: "git";
  branch: string | null;
  /** Commits this phase made, newest first. */
  commits: MadeCommit[];
  push: PushWork | null;
  pullRequest: PullRequestWork | null;
  /** The newest commit the phase reached: what it pushed, or else what it committed last. */
  tip: string | null;
}

export interface CommandObject extends Common {
  kind: "command";
  chip: WorkChip;
  /** Its last lines, for a run still going or one that failed. */
  tail: string[];
}

export interface WebObject extends Common {
  kind: "web";
  chip: WorkChip;
  links: WebLink[];
}

export interface FetchObject extends Common {
  kind: "fetch";
  chip: WorkChip;
  url: string;
  /** The page's first line of text. */
  excerpt: string | null;
}

export interface ToolObject extends Common {
  kind: "tool";
  chip: WorkChip;
  /** "Used Figma", "Searched memory": the section the call went under. */
  section: string;
}

type ToolBlock = Extract<Block, { kind: "tool" }>;

type Input = Record<string, unknown>;
const str = (value: unknown) => (typeof value === "string" ? value : "");

const digests = new WeakMap<ToolBlock, ToolDigest | null>();

/**
 * What a call's output came to. A finished call that left its output out of the page has the core's digest; a live
 * one reads what it has streamed so far. Progress is not output: Claude sends its description and a "Running for
 * 30s" heartbeat there.
 */
export function blockDigest(block: ToolBlock): ToolDigest | null {
  if (block.digest) return block.digest;
  if (digests.has(block)) return digests.get(block)!;
  const digest = toolDigest(block.output);
  digests.set(block, digest);
  return digest;
}

export function objectState(block: ToolBlock): ObjectState {
  if (!block.done) return "running";
  if (block.isError || block.status === "error") return "failed";
  return block.status === "cancelled" || block.status === "disconnected" ? "stopped" : "done";
}

/** The steps of a shell call that the work view draws in their own terms. */
function domainsOf(command: string): RunDomain[] {
  return readCommand(command).flatMap((action) => (action.type === "unknown" && action.run?.domain ? [action.run.domain] : []));
}

const plainChip = (block: ToolBlock, part: CallPart): WorkChip => ({ ...(part.chip ?? { key: block.id, label: part.section, title: part.section, kind: "tool" }), blocks: [block] });

/* ------------------------------------------------------------------ Search */

const COUNTED = /^Found (\d+) (?:files?|matches?)/;
const NONE = /^No (?:matches|files) found/;
/** A match: `path:12:text`, or `12:text` from a search of one file. */
const MATCH = /^(?:(.+?):)?(\d+):(.*)$/;
/** Context lines around a match use `-`, and groups of them are split by `--`. */
const CONTEXT = /^(?:.+?-)?\d+-|^--$/;
/** A listed file: one path-like word. One that ends in an extension is a file even when it looks like context. */
const FILE = /^[\w./@~+-]+$/;
/** Notes Claude Code adds after a command's output, which the search never printed. */
const HARNESS_NOTE = /^(Shell cwd was reset to |\[This command modified )/;

type HitLine = { hit: SearchHit } | { skip: "note" | "context" } | null;

/** `folder` is where the search ran, which the paths it printed are relative to. */
function hitLine(line: string, searched: string, folder: string | null): HitLine {
  if (COUNTED.test(line) || NONE.test(line) || HARNESS_NOTE.test(line)) return { skip: "note" };
  const match = MATCH.exec(line);
  if (match) return { hit: { path: joinPath(folder, match[1] ?? searched), line: Number(match[2]), text: match[3]!.trim() } };
  const word = line.trim();
  if (FILE.test(word) && (/\.\w+$/.test(word) || !CONTEXT.test(word))) return { hit: { path: joinPath(folder, word), line: null, text: "" } };
  return CONTEXT.test(line) ? { skip: "context" } : null;
}

interface ReadHits {
  hits: SearchHit[];
  /** Lines that were notes rather than hits. */
  notes: number;
  /** Every line read as a hit or a note, with no context lines among them, so each other printed line is a hit too. */
  plain: boolean;
}

/** The lines a search printed as hits: `path:line:text`, or the files it listed. Lines it cannot read are left out. */
function searchHits(lines: string[], searched: string, folder: string | null): ReadHits {
  const read = lines.map((line) => hitLine(line, searched, folder));
  return {
    hits: read.flatMap((line) => (line && "hit" in line ? [line.hit] : [])),
    notes: read.filter((line) => line && "skip" in line && line.skip === "note").length,
    plain: read.every((line) => line !== null && !("skip" in line && line.skip === "context")),
  };
}

/**
 * How many it found: the count it printed, the chip's own count, "no matches", OpenCode's count, or every line it
 * printed when all of them read as hits.
 */
function matchCount(digest: ToolDigest | null, chip: WorkChip, read: ReadHits): number | null {
  const head = digest?.head ?? [];
  const counted = head.map((line) => COUNTED.exec(line) ?? /"matches":(\d+)/.exec(line)).find(Boolean);
  if (counted) return Number(counted[1]);
  const noted = /^(\d+) match/.exec(chip.note ?? "");
  if (noted) return Number(noted[1]);
  if (chip.note === "no matches" || head.some((line) => NONE.test(line))) return 0;
  if (!digest || !read.hits.length) return null;
  const shown = digest.head.length + digest.tail.length;
  if (shown >= digest.lines) return read.hits.length;
  return read.plain ? digest.lines - read.notes : null;
}

/** The file a one-file search looked in: the tool's path, or the scope the command reader found in a shell search. */
function searchedPath(block: ToolBlock): string {
  const scope = readCommand(commandText(block)).find((action) => action.type === "search")?.scope;
  return str(((block.input ?? {}) as Input)["path"]) || (scope?.replace(/^in /, "") ?? "");
}

/** Where a search ran: the call's own folder, moved by any `cd` before the search. */
function searchFolder(block: ToolBlock): string | null {
  const input = (block.input ?? {}) as Input;
  const cwd = str(input["cwd"]) || str(input["workdir"]) || null;
  const moved = readCommand(commandText(block)).find((action) => action.type === "search")?.folder ?? null;
  return moved ? joinPath(cwd, moved) : cwd;
}

function searchObject(block: ToolBlock, part: CallPart, alone: boolean): SearchObject {
  const chip = plainChip(block, part);
  const digest = block.done ? blockDigest(block) : null;
  // A call that ran several searches printed them together; whose lines are whose cannot be told apart.
  const read = digest && alone && !block.isError ? searchHits([...digest.head, ...digest.tail], searchedPath(block), searchFolder(block)) : { hits: [], notes: 0, plain: false };
  const matches = alone ? matchCount(block.isError ? null : digest, chip, read) : null;
  return { kind: "search", id: `${block.id}:search`, state: objectState(block), blocks: [block], chip, hits: read.hits.slice(0, 6), matches };
}

/* ------------------------------------------------------------------ Edits */

const MAX_LINES = 2;
const MAX_CHARS = 160;

const shown = (lines: string[]) =>
  lines
    .filter((line) => line.trim())
    .slice(0, MAX_LINES)
    .map((line) => (line.trim().length > MAX_CHARS ? `${line.trim().slice(0, MAX_CHARS - 1)}…` : line.trim()));

/** The lines a replacement changed, without the ones it kept at either end. */
function replaced(before: string, after: string): EditLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return [...shown(a.slice(start, a.length - end)).map((text) => ({ sign: "-" as const, text })), ...shown(b.slice(start, b.length - end)).map((text) => ({ sign: "+" as const, text }))];
}

/** A diff's header lines, which name files rather than change them; a removed `-- comment` is a change. */
const DIFF_HEADER = /^(?:(?:\+\+\+|---) (?:a\/|b\/|\/dev\/null|")|\*\*\* |@@|diff --git|index |new file mode|deleted file mode)/;

/** A patch's changed lines for one file: unified hunks, or an apply_patch section. */
function patchLines(patch: string): EditLine[] {
  const body = patch.split("\n").filter((line) => !DIFF_HEADER.test(line));
  const removed = body.filter((line) => line.startsWith("-")).map((line) => line.slice(1));
  const added = body.filter((line) => line.startsWith("+")).map((line) => line.slice(1));
  return [...shown(removed).map((text) => ({ sign: "-" as const, text })), ...shown(added).map((text) => ({ sign: "+" as const, text }))];
}

/** Each agent's edit shapes, tried in order: a list of file changes, a patch, edits, a replacement, whole content. */
const editReaders: ((input: unknown, path: string, block: ToolBlock) => { lines: EditLine[]; created: boolean } | null)[] = [
  (input, path) => {
    if (!Array.isArray(input)) return null;
    const entry = (input as Input[]).find((candidate) => candidate?.["path"] === path);
    if (!entry) return null;
    const diff = str(entry["diff"]);
    const created = changeKind(entry) === "add" || /^(new file mode|--- \/dev\/null)/m.test(diff);
    // Codex carries an added file's whole text rather than a patch.
    const raw = created && !/^@@ |^diff --git |^--- /m.test(diff);
    return { lines: raw ? shown(diff.split("\n")).map((text) => ({ sign: "+" as const, text })) : patchLines(diff), created };
  },
  (input, path) => {
    const patch = str((input as Input)["patch"]) || str((input as Input)["input"]);
    const section = patch ? patchSections(patch).find((candidate) => candidate.path === path) : undefined;
    return section ? { lines: patchLines(section.body.join("\n")), created: section.created } : null;
  },
  (input) => {
    const edits = (input as Input)["edits"];
    if (!Array.isArray(edits)) return null;
    const lines = (edits as Input[]).flatMap((edit) => replaced(str(edit?.["old_string"] ?? edit?.["oldString"]), str(edit?.["new_string"] ?? edit?.["newString"])));
    return { lines: [...lines.filter((line) => line.sign === "-").slice(0, MAX_LINES), ...lines.filter((line) => line.sign === "+").slice(0, MAX_LINES)], created: false };
  },
  (input) => {
    const record = input as Input;
    const before = record["old_string"] ?? record["oldString"];
    const after = record["new_string"] ?? record["newString"];
    return typeof before === "string" && typeof after === "string" ? { lines: replaced(before, after), created: before === "" } : null;
  },
  (input, _, block) => {
    const content = (input as Input)["content"];
    if (typeof content !== "string") return null;
    const said = blockDigest(block)?.head[0] ?? "";
    return { lines: shown(content.split("\n")).map((text) => ({ sign: "+" as const, text })), created: /^(File created|Created|Wrote) /i.test(said) };
  },
];

function editObject(block: ToolBlock, part: CallPart): EditObject {
  const chip = plainChip(block, part);
  const input = block.input ?? {};
  const read = chip.path ? editReaders.reduce<ReturnType<(typeof editReaders)[number]>>((found, reader) => found ?? reader(input, chip.path!, block), null) : null;
  return { kind: "edit", id: `${block.id}:${chip.key}`, state: objectState(block), blocks: [block], chip, created: read?.created ?? false, lines: read?.lines ?? [] };
}

/* ------------------------------------------------------------------ Git */

/** A command's value for a flag, from its words: `--title "x"`, `-t x`, `--base=main`. */
function flag(words: string[], ...names: string[]): string | null {
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    const inline = names.map((name) => (word.startsWith(`${name}=`) ? word.slice(name.length + 1) : null)).find((value) => value !== null);
    if (inline) return inline;
    if (names.includes(word) && index + 1 < words.length) return words[index + 1]!;
  }
  return null;
}

/** The words of the call's step that runs `program sub`, such as `gh pr create` or `git push`. */
function stepWords(command: string, ...lead: string[]): string[] {
  for (const step of shellSteps(unwrapShell(command))) {
    const words = commandLine(step.text).words;
    const at = words.indexOf(lead[0]!);
    if (
      at >= 0 &&
      lead.every((word, index) =>
        index === 0
          ? true
          : words
              .slice(at + 1)
              .filter((candidate) => !candidate.startsWith("-"))
              .includes(word),
      )
    )
      return words.slice(at);
  }
  return [];
}

/** "Writing objects:  64% (18/28)": the push's latest progress line in what it has printed. */
function pushProgress(text: string): { progress: number; objects: string } | null {
  const matches = [...text.matchAll(/Writing objects:\s+(\d+)% \((\d+\/\d+)\)/g)];
  const last = matches[matches.length - 1];
  return last ? { progress: Number(last[1]) / 100, objects: last[2]! } : null;
}

/** `git push`'s flags that take a value, so the remote is the first word that is neither a flag nor a flag's value. */
const PUSH_VALUED = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

function pushRemote(words: string[]): string {
  const remote = words.slice(2).find((word, index, rest) => !word.startsWith("-") && !PUSH_VALUED.has(rest[index - 1] ?? ""));
  return remote ?? "origin";
}

function pushWork(block: ToolBlock, command: string, digest: ToolDigest | null): PushWork {
  const words = stepWords(command, "git", "push");
  const live = !block.done ? pushProgress(typeof block.output === "string" ? block.output : (block.progress ?? "")) : null;
  const ref = digest?.git?.pushes[0] ?? null;
  // A push the remote refused can still exit 0 behind a pipe; what it printed says it failed.
  const state = ref?.rejected ? "failed" : objectState(block);
  return { state, remote: pushRemote(words), ref, progress: live?.progress ?? (state === "done" ? 1 : null), objects: live?.objects ?? null };
}

function pullRequestWork(block: ToolBlock, command: string, digest: ToolDigest | null): PullRequestWork {
  const words = stepWords(command, "gh", "pr", "create");
  const found = digest?.git?.pullRequest ?? null;
  return { state: objectState(block), number: found?.number ?? null, url: found?.url ?? null, title: flag(words, "--title", "-t"), base: flag(words, "--base", "-B") };
}

const publishes = (domains: RunDomain[]) => domains.some((domain) => domain === "commit" || domain === "push" || domain === "pull-request");

/**
 * A phase's Git calls as one branch: what it committed, what it pushed, the pull request it opened. Looks at the
 * branch ride along as its calls; only the calls that publish decide whether it worked. It takes the id the first of
 * those had as a plain call, so it keeps its place when that call's command arrives late.
 */
function gitObject(calls: { block: ToolBlock; domains: RunDomain[] }[]): GitObject {
  const first = calls.find(({ domains }) => publishes(domains))!.block;
  const object: GitObject = { kind: "git", id: `${first.id}:0`, state: "done", blocks: [], branch: null, commits: [], push: null, pullRequest: null, tip: null };
  const states: (ObjectState | undefined)[] = [];
  for (const { block, domains } of calls) {
    const command = commandText(block);
    const digest = blockDigest(block);
    object.blocks.push(block);
    for (const made of digest?.git?.commits ?? []) {
      object.commits.unshift({ sha: made.sha, subject: made.subject, at: block.at });
      object.branch = made.branch;
    }
    if (domains.includes("push")) object.push = pushWork(block, command, digest);
    if (domains.includes("pull-request")) object.pullRequest = pullRequestWork(block, command, digest);
    if (publishes(domains)) states.push(objectState(block));
  }
  const ref = object.push?.ref;
  object.branch = ref?.source ?? object.branch;
  object.tip = ref?.to ?? object.commits[0]?.sha ?? null;
  states.push(object.push?.state);
  object.state = (["running", "failed", "stopped"] as const).find((state) => states.includes(state)) ?? "done";
  return object;
}

/* ------------------------------------------------------------------ Calls */

/** The case count of the last finished run of the same command before this one. */
function expectedCases(block: ToolBlock, earlier: ToolBlock[]): number | null {
  const command = commandText(block);
  const folder = (candidate: ToolBlock) => str(((candidate.input ?? {}) as Input)["cwd"]);
  const before = earlier.findLast((candidate) => candidate !== block && candidate.done && commandText(candidate) === command && folder(candidate) === folder(block) && blockDigest(candidate)?.tests);
  const run = before ? blockDigest(before)!.tests! : null;
  return run ? run.passed + run.failed + run.skipped : null;
}

function testsObject(block: ToolBlock, part: CallPart, earlier: ToolBlock[]): TestsObject {
  return {
    kind: "tests",
    id: `${block.id}:tests`,
    state: objectState(block),
    blocks: [block],
    chip: plainChip(block, part),
    run: blockDigest(block)?.tests ?? null,
    expected: expectedCases(block, earlier),
  };
}

function commandObject(block: ToolBlock, part: CallPart): CommandObject {
  const digest = blockDigest(block);
  return {
    kind: "command",
    id: `${block.id}:command`,
    state: objectState(block),
    blocks: [block],
    chip: plainChip(block, part),
    tail: digest ? (digest.tail.length ? digest.tail : digest.head).slice(-3) : [],
  };
}

function readObject(block: ToolBlock, part: CallPart): ReadObject {
  return { kind: "read", id: `${block.id}:read`, state: objectState(block), blocks: [block], rows: part.chip ? [plainChip(block, part)] : [] };
}

function webObject(block: ToolBlock, part: CallPart): WebObject {
  return { kind: "web", id: `${block.id}:web`, state: objectState(block), blocks: [block], chip: plainChip(block, part), links: blockDigest(block)?.links ?? [] };
}

function fetchObject(block: ToolBlock, part: CallPart): FetchObject {
  const first = blockDigest(block)?.head.find((line) => /[a-z]{3,}.*\s.*[a-z]{3,}/i.test(line) && !/^(https?:|<|\{|\[)/.test(line.trim()));
  return { kind: "fetch", id: `${block.id}:fetch`, state: objectState(block), blocks: [block], chip: plainChip(block, part), url: part.chip?.title ?? "", excerpt: first?.trim() ?? null };
}

/** A tool by what it did, with what it was asked beside it: "explore" and the query. */
function toolObject(block: ToolBlock, part: CallPart): ToolObject {
  const chip = plainChip(block, part);
  const asked = toolCallPresentation(block.name, block.input).object;
  return { kind: "tool", id: block.id, state: objectState(block), blocks: [block], chip: chip.detail || !asked || asked === chip.label ? chip : { ...chip, detail: asked }, section: part.section };
}

/** Which object each section of a call becomes. */
const bySection: Record<string, (block: ToolBlock, part: CallPart, parts: CallPart[]) => WorkObject> = {
  Read: readObject,
  Listed: readObject,
  Searched: (block, part, parts) => searchObject(block, part, parts.filter((other) => other.section === "Searched").length === 1),
  Edited: editObject,
  Fetched: fetchObject,
  "Searched the web": webObject,
};

/**
 * One call's objects. A shell call reads as a test run while one known by its command runs, and once it printed a
 * runner's counts, which also catches a script the reader cannot follow.
 */
function callObjects(block: ToolBlock, earlier: ToolBlock[]): WorkObject[] {
  const parts = callParts(block);
  const shell = Boolean(commandText(block)) && toolCallPresentation(block.name, block.input).verb === "Ran";
  // A run that finished without printing a runner's counts has nothing a test drawing could add to its card.
  const tests = shell && (Boolean(blockDigest(block)?.tests) || (!block.done && domainsOf(commandText(block)).includes("tests")));
  return parts.map((part, index) => {
    const ran = () => (tests ? testsObject(block, part, earlier) : commandObject(block, part));
    const object = part.section === "Ran" ? ran() : (bySection[part.section] ?? toolObject)(block, part, parts);
    // The id stays with the call's part, so an object keeps its place and state when a run turns out a plain command.
    return { ...object, id: `${block.id}:${index}` };
  });
}

const isGitCall = (block: ToolBlock) => domainsOf(commandText(block)).some((domain) => domain === "commit" || domain === "push" || domain === "pull-request");

/** A call that only looks at the branch: in a step that publishes it, part of drawing the branch. */
function looksAtBranch(block: ToolBlock): boolean {
  const actions = readCommand(commandText(block));
  const runs = actions.filter((action) => action.type === "unknown" && !action.preparation);
  return runs.length > 0 && actions.every((action) => action.type === "unknown") && runs.every((action) => action.type === "unknown" && action.run?.domain === "branch");
}

/** Consecutive reads are one object; the rows a later call repeats are not drawn twice. */
function mergeReads(objects: WorkObject[]): WorkObject[] {
  const merged: WorkObject[] = [];
  for (const object of objects) {
    const last = merged[merged.length - 1];
    if (object.kind !== "read" || last?.kind !== "read") {
      merged.push(object);
      continue;
    }
    last.blocks.push(...object.blocks.filter((block) => !last.blocks.includes(block)));
    for (const row of object.rows) if (!last.rows.some((existing) => existing.key === row.key)) last.rows.push(row);
    if (object.state === "running") last.state = "running";
  }
  return merged;
}

/**
 * A phase's calls as objects, in the order they first appeared. `turn` is the whole turn, so a test run can find the
 * run of the same command before it; `live`, whether the turn still runs. Subagents and the plan have their own rows
 * and are left out.
 */
export function workObjects(blocks: Block[], turn: Block[] = blocks, live = true): WorkObject[] {
  // A call still open when its turn ended will not finish: it stopped with the turn.
  const settled = live ? blocks : blocks.map((block) => (block.kind === "tool" && !block.done ? { ...block, done: true, status: "cancelled" as const } : block));
  const tools = settled.filter((block): block is ToolBlock => block.kind === "tool" && !block.subagent && !/^todowrite$/i.test(block.name));
  const earlier = turn.filter((block): block is ToolBlock => block.kind === "tool");
  const publishing = tools.some((block) => Boolean(commandText(block)) && isGitCall(block));
  const git = publishing ? tools.filter((block) => Boolean(commandText(block)) && (isGitCall(block) || looksAtBranch(block))) : [];
  // The branch draws where the phase first publishes, after the edits that led to it; looks before that ride along.
  const lead = git.find(isGitCall);
  const objects: WorkObject[] = [];
  for (const block of tools) {
    if (git.includes(block)) {
      if (block === lead) objects.push(gitObject(git.map((call) => ({ block: call, domains: domainsOf(commandText(call)) }))));
      continue;
    }
    const at = earlier.findIndex((candidate) => candidate.id === block.id);
    objects.push(...callObjects(block, at < 0 ? [] : earlier.slice(0, at)));
  }
  return mergeReads(objects);
}
