import type { Block } from "./transcript.js";
import { basename, commandText } from "./work-chips.js";
import { workObjects, type CommandObject, type EditObject, type TestsObject, type WorkObject } from "./work-objects.js";
import { objectOutcome } from "./work-outcomes.js";
import { checkOf, piped, type CheckKind } from "./work-receipt.js";

/**
 * Proof beside claims. A reply says what the turn did: "fixed the crash", "the tests pass". The turn's own calls hold
 * what backs each sentence: the edit, the test run. This reads both, so a sentence can carry what stands behind it,
 * and a check the reply says passed that the turn never ran can say so.
 */

/** A file the turn changed, with every edit it made to it. */
export interface FileProof {
  kind: "file";
  key: string;
  path: string;
  edits: EditObject[];
}

/** Every file the turn changed, for a sentence that says it changed things and names none of them. */
export interface ChangesProof {
  kind: "changes";
  key: string;
  files: FileProof[];
}

/** The last run of a check. `stale`: the turn edited a file after it ran. */
export interface CheckProof {
  kind: "check";
  key: string;
  check: CheckKind;
  run: TestsObject | CommandObject;
  outcome: "passed" | "failed" | "ran";
  stale: boolean;
}

/** A check a sentence says passed, which the turn did not run. */
export interface MissingProof {
  kind: "missing";
  key: string;
  check: CheckKind;
}

export type Proof = FileProof | ChangesProof | CheckProof | MissingProof;

/** What a turn did that its reply can call on. */
export interface TurnEvidence {
  files: FileProof[];
  checks: CheckProof[];
  /**
   * The checks the turn's changes surely went without: it changed files, none of its commands could be the check under
   * another name, and it started no agent that could have run it. A turn that changed nothing may speak of an earlier
   * turn's run, so nothing is unrun there.
   */
  unrun: CheckKind[];
}

/** The same, by name alone: light enough to hand a Markdown renderer as an option. */
export interface ProofNames {
  files: string[];
  checks: CheckKind[];
  unrun: CheckKind[];
}

const KINDS: CheckKind[] = ["tests", "typecheck", "lint", "build"];
const CHANGES = "changes";

/** Words and notes, which no check reads: an edit to one leaves an earlier run standing. */
const PROSE = /\.(md|mdx|txt|rst)$/i;

/** A command that may be the check under a name the app does not know, such as `make check` or a script of the project's. */
const MAYBE: Record<CheckKind, RegExp> = {
  tests: /test|spec|check|verify|\bci\b/i,
  typecheck: /tsc|type|check|mypy|pyright/i,
  lint: /lint|check|ruff|clippy|format/i,
  build: /build|compile|make|bundle|tsc|cargo|gradle/i,
};

/** The tool an object's last call used and the command it gave, in one line. */
function called(object: WorkObject): string {
  const call = object.blocks.findLast((block): block is Extract<Block, { kind: "tool" }> => block.kind === "tool");
  return call ? `${call.name} ${commandText(call)}` : "";
}

function checkRun(object: TestsObject | CommandObject): { check: CheckKind; outcome: CheckProof["outcome"] } | null {
  if (object.state !== "done" && object.state !== "failed") return null;
  const command = called(object);
  // Counted results are the runner's own words: they hold whatever a pipe did to the exit code.
  if (object.kind === "tests" && object.run) return { check: "tests", outcome: objectOutcome(object)?.failed ? "failed" : "passed" };
  const check = object.kind === "tests" ? "tests" : checkOf(command);
  if (!check) return null;
  if (object.state === "failed") return { check, outcome: "failed" };
  return { check, outcome: piped(command) ? "ran" : "passed" };
}

/** What a turn's work holds for its reply to call on. `work`: the turn's blocks. */
export function turnEvidence(work: Block[]): TurnEvidence {
  const objects = workObjects(work, work, false);
  const files = new Map<string, FileProof>();
  const checks = new Map<CheckKind, CheckProof>();
  let lastEdit = -1;
  objects.forEach((object, index) => {
    if (object.kind === "edit" && object.state === "done" && object.chip.path) {
      const path = object.chip.path;
      const known = files.get(path) ?? { kind: "file" as const, key: `file:${path}`, path, edits: [] };
      files.set(path, { ...known, edits: [...known.edits, object] });
      if (!PROSE.test(path)) lastEdit = index;
    }
    if (object.kind !== "tests" && object.kind !== "command") return;
    const ran = checkRun(object);
    if (ran) checks.set(ran.check, { kind: "check", key: `check:${ran.check}`, ...ran, run: object, stale: false });
  });
  const order = new Map(objects.map((object, index) => [object.id, index]));
  const delegated = work.some((block) => block.kind === "tool" && block.subagent);
  // What it ran, as opposed to what it read: a look at a test file is not a run of the tests.
  const ran = objects.flatMap((object) => (object.kind === "command" || object.kind === "tests" || object.kind === "tool" ? [called(object)] : []));
  return {
    files: [...files.values()],
    checks: [...checks.values()].map((check) => ({ ...check, stale: (order.get(check.run.id) ?? 0) < lastEdit })),
    unrun: delegated || !files.size ? [] : KINDS.filter((kind) => !checks.has(kind) && !ran.some((command) => MAYBE[kind].test(command))),
  };
}

export function proofNames(evidence: TurnEvidence): ProofNames {
  return { files: evidence.files.map((file) => file.path), checks: evidence.checks.map((check) => check.check), unrun: evidence.unrun };
}

/** The proof a key stands for, or null when the turn holds none by that key. */
export function proofOf(evidence: TurnEvidence, key: string): Proof | null {
  if (key === CHANGES) return evidence.files.length ? { kind: "changes", key, files: evidence.files } : null;
  const missing = /^missing:(.+)$/.exec(key)?.[1] as CheckKind | undefined;
  if (missing) return evidence.unrun.includes(missing) ? { kind: "missing", key, check: missing } : null;
  return evidence.files.find((file) => file.key === key) ?? evidence.checks.find((check) => check.key === key) ?? null;
}

/* ------------------------------------------------------------------ What a sentence calls on */

const parts = (path: string) => path.replace(/\\/g, "/").split("/").filter(Boolean);
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The shortest end of a path that names it among the turn's files: `Row.tsx`, or `list/Row.tsx` where two share the name. */
function shortestName(path: string, all: string[]): string {
  const own = parts(path);
  for (let size = 1; size < own.length; size += 1) {
    const tail = own.slice(-size).join("/");
    if (!all.some((other) => other !== path && parts(other).slice(-size).join("/") === tail)) return tail;
  }
  return own.join("/");
}

/** A file is named where its name stands whole: after a folder or a gap, and not as the start of a longer name. */
function namesFile(passage: string, name: string): boolean {
  return new RegExp(String.raw`(?<![\p{L}\p{N}_.-])${escaped(name)}(?![\p{L}\p{N}_-]|\.[\p{L}\p{N}])`, "u").test(passage.replace(/\\/g, "/"));
}

/** The words a sentence uses for each check. */
const SAID: Record<CheckKind, RegExp> = {
  tests: /\b(tests?|specs?|suites?|vitest|jest|pytest)\b/i,
  typecheck: /\b(type[- ]?check(?:s|ed|ing)?|tsc|mypy|pyright)\b|\btypes (?:are )?clean\b/i,
  lint: /\b(lint(?:s|ed|er|ing)?|eslint|ruff|clippy)\b/i,
  build: /\b(builds?|compiles?)\b/i,
};
const PASSED = /\b(pass(?:es|ed|ing)?|green|clean(?:ly)?(?! up)|succeed(?:s|ed)?|successful(?:ly)?)\b|\bno (?:errors|failures|warnings)\b/i;
const OUTCOME = /\b(fail(?:s|ed|ing|ures?)?|broken?|errors?|verif(?:y|ied)|confirm(?:s|ed)|ran)\b/i;
/** Words that make a sentence a plan, a question or a denial rather than a claim. */
const UNSURE =
  /\b(not|never|without|should|would|could|might|may|will|shall|needs? to|ha(?:ve|s) to|wants? to|going to|if|once|until|unless|whether|please|pending|unverified|untested|skipp?ed)\b|n['’]t\b|\?/i;
/** What was done to the files, in the past: "fixes" and "changes" are as often things as deeds. */
const CHANGED = /\b(fixed|changed|added|removed|updated|renamed|moved|replaced|rewrote|rewritten|deleted|implemented|refactored|edited|no longer)\b/i;

/** The checks one sentence speaks of, in the order it names them, so its marks read the way it does. */
function sentenceChecks(sentence: string, names: ProofNames): string[] {
  const passed = PASSED.test(sentence);
  if (!passed && !OUTCOME.test(sentence)) return [];
  // A check that never ran is called out only under a plain claim that it passed.
  const claimed = passed && !UNSURE.test(sentence) && !/\bfail/i.test(sentence);
  const said = KINDS.flatMap((kind) => {
    const at = SAID[kind].exec(sentence)?.index;
    return at === undefined ? [] : [{ kind, at }];
  }).sort((a, b) => a.at - b.at);
  return said.flatMap(({ kind }) => {
    if (names.checks.includes(kind)) return [`check:${kind}`];
    return claimed && names.unrun.includes(kind) ? [`missing:${kind}`] : [];
  });
}

/** Each sentence is read by itself: "it failed first" does not unsay "all 12 tests pass" after it. */
function checkKeys(passage: string, names: ProofNames): string[] {
  return [...new Set(passage.split(/(?<=[.!?])\s+/).flatMap((sentence) => sentenceChecks(sentence, names)))];
}

/** How far into a sentence its claim may start: "The app's title fix is implemented" still leads with it. */
const LEAD = 8;

/**
 * Whether a passage leads with what was done to the files: "Fixed the crash", "The crash is fixed", "What I changed".
 * A deed told further in, or in an aside in brackets, is not what the passage is for.
 */
function saysChanged(passage: string): boolean {
  const own = passage.replace(/\([^)]*\)/g, " ").trim();
  if (own.endsWith("?")) return false;
  const [first = ""] = own.split(/[.!?:](?:\s|$)/);
  return CHANGED.test(first.split(/\s+/).slice(0, LEAD).join(" "));
}

/**
 * The proofs a passage of the reply calls on, by key: each changed file it names, or the change as a whole where it
 * leads with a change and names no file, and each check whose outcome it speaks of. Notes alone are not the change a
 * sentence speaks of, so a turn that edited only those backs no sentence that names none.
 */
export function passageProofs(passage: string, names: ProofNames): string[] {
  const named = names.files.filter((path) => namesFile(passage, shortestName(path, names.files))).map((path) => `file:${path}`);
  const changed = !named.length && names.files.some((path) => !PROSE.test(path)) && saysChanged(passage);
  return [...named, ...(changed ? [names.files.length === 1 ? `file:${names.files[0]}` : CHANGES] : []), ...checkKeys(passage, names)];
}

/** A proof and the line of the reply that calls on it first. */
export interface ProofMark {
  key: string;
  line: string;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
/** Lines no sentence stands on: headings, table rows and rules. */
const UNMARKED = /^\s{0,3}(#{1,6}\s|\||[-*_]{3,}\s*$)/;
/** Enough of a line to find it again in the part of the reply a renderer holds. */
const LINE = 160;
/** A line of a reply as a mark names it. */
export const markLine = (line: string): string => line.trim().slice(0, LINE);

/**
 * Where each proof goes in a reply: on the first line that calls on it, so a file named five times carries its
 * change once. Code blocks, headings and tables carry none.
 */
export function replyMarks(text: string, names: ProofNames): ProofMark[] {
  if (!names.files.length && !names.checks.length && !names.unrun.length) return [];
  const marks: ProofMark[] = [];
  const taken = new Set<string>();
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const mark = FENCE.exec(line)?.[1];
    if (mark && (fence === null || mark.startsWith(fence))) {
      fence = fence === null ? mark : null;
      continue;
    }
    if (fence !== null || UNMARKED.test(line) || !line.trim()) continue;
    for (const key of passageProofs(line, names)) {
      if (taken.has(key)) continue;
      taken.add(key);
      marks.push({ key, line: markLine(line) });
    }
  }
  return marks;
}

/* ------------------------------------------------------------------ What a proof says */

export interface ProofLabel {
  text: string;
  /** ok: it holds. bad: it failed. null: it cannot tell, or there is nothing to hold. */
  tone: "ok" | "bad" | null;
}

const CHECK_NAME: Record<CheckKind, string> = { tests: "Tests", typecheck: "Typecheck", lint: "Lint", build: "Build" };
const NOT_RUN: Record<CheckKind, string> = { tests: "No test run this turn", typecheck: "No typecheck this turn", lint: "No lint run this turn", build: "No build this turn" };

function sizeOf(edits: EditObject[]): string {
  const added = edits.reduce((sum, edit) => sum + (edit.chip.added ?? 0), 0);
  const removed = edits.reduce((sum, edit) => sum + (edit.chip.removed ?? 0), 0);
  if (!added && !removed) return edits.some((edit) => edit.created) ? "new" : "";
  return [added || !removed ? `+${added}` : "", removed ? `−${removed}` : ""].filter(Boolean).join(" ");
}

function checkLabel(check: CheckProof): ProofLabel {
  const counted = check.run.kind === "tests" && check.run.run ? objectOutcome(check.run)?.text : null;
  const words = counted ?? `${CHECK_NAME[check.check]} ${check.outcome}`;
  if (check.outcome === "failed") return { text: words, tone: "bad" };
  // A pass from before the last edit proves the code as it was then.
  if (check.stale) return { text: `${words} before the last edit`, tone: null };
  return { text: words, tone: check.outcome === "passed" ? "ok" : null };
}

/** A proof in a few words: "WorkActs.tsx +6 −1", "3 files +21 −8", "1055 passed", "No test run this turn". */
export function proofLabel(proof: Proof): ProofLabel {
  switch (proof.kind) {
    case "file":
      return { text: [basename(proof.path), sizeOf(proof.edits)].filter(Boolean).join(" "), tone: "ok" };
    case "changes":
      return { text: [`${proof.files.length} files`, sizeOf(proof.files.flatMap((file) => file.edits))].filter(Boolean).join(" "), tone: "ok" };
    case "check":
      return checkLabel(proof);
    case "missing":
      return { text: NOT_RUN[proof.check], tone: null };
  }
}
