import { shortSha } from "./time.js";
import type { CommandObject, EditObject, GitObject, TestsObject, WorkObject } from "./work-objects.js";

/** What an object came to, in a few words, and whether that is bad news. */
export interface Outcome {
  text: string;
  failed: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function gitOutcome(git: GitObject): Outcome | null {
  const { pullRequest: pr, push } = git;
  if (pr?.state === "failed") return { text: "Pull request failed", failed: true };
  if (pr?.number) return { text: `Opened #${pr.number}`, failed: false };
  if (pr?.state === "running") return { text: "Opening a pull request", failed: false };
  if (push?.state === "failed") return { text: push.ref?.rejected ? "Push rejected" : "Push failed", failed: true };
  // How many commits a push sends is the core's to count; the outcome names where they went.
  if (push?.state === "running") return { text: `Pushing to ${push.remote}`, failed: false };
  if (push?.state === "stopped") return { text: "Push stopped", failed: false };
  if (push?.state === "done") return { text: push.ref?.created ? `Published to ${push.remote}` : `Pushed to ${push.remote}`, failed: false };
  if (git.state === "failed") return { text: "Commit failed", failed: true };
  return git.commits[0] ? { text: `Committed ${shortSha(git.commits[0].sha)}`, failed: false } : null;
}

function testsOutcome(tests: TestsObject): Outcome | null {
  const run = tests.run;
  if (!run) return tests.state === "failed" ? { text: "Tests failed", failed: true } : null;
  if (run.failed) return { text: `${run.failed} failed`, failed: true };
  if (tests.state === "running") return { text: tests.expected ? `${run.passed} of ${tests.expected} passed` : `${run.passed} passed`, failed: false };
  // A run the turn's end cut short passed nothing yet.
  if (tests.state === "stopped") return { text: "Tests stopped", failed: false };
  if (tests.state === "failed") return { text: "Tests failed", failed: true };
  // `go test` without -v names only its packages; "0 passed" would be wrong.
  return { text: run.passed ? `${run.passed} passed` : "Tests passed", failed: false };
}

function editOutcome(edit: EditObject): Outcome | null {
  if (edit.state === "failed") return { text: "Edit failed", failed: true };
  const { added, removed } = edit.chip;
  // An edit whose shape carries no counts says nothing rather than "+0".
  if (added === undefined && removed === undefined) return null;
  return { text: [added || !removed ? `+${added ?? 0}` : "", removed ? `−${removed}` : ""].filter(Boolean).join(" "), failed: false };
}

/** What each kind of object came to; reads and fetches come to nothing worth a word of their own. */
const outcomes: { [K in WorkObject["kind"]]: (object: Extract<WorkObject, { kind: K }>) => Outcome | null } = {
  git: gitOutcome,
  tests: testsOutcome,
  edit: editOutcome,
  search: (search) => (search.matches === null ? null : { text: search.matches ? plural(search.matches, "match", "matches") : "no matches", failed: false }),
  web: (web) => (web.links.length ? { text: plural(web.links.length, "result"), failed: false } : null),
  command: (command) => (command.state === "failed" ? { text: failedWords(command.chip), failed: true } : null),
  read: () => null,
  fetch: () => null,
  tool: () => null,
};

export function objectOutcome(object: WorkObject): Outcome | null {
  return (outcomes[object.kind] as (object: WorkObject) => Outcome | null)(object);
}

/** "Typecheck failed" for a run with plain words for it; a command shown as written fails as a command. */
function failedWords(chip: CommandObject["chip"]): string {
  const ran = chip.done?.length === 1 ? /^Ran (?:the )?(.+)$/.exec(chip.done[0]!)?.[1] : undefined;
  return ran ? `${ran.charAt(0).toUpperCase()}${ran.slice(1)} failed` : "Command failed";
}

/** A failed run of a check that passed later in the same phase is history, not news. */
function superseded(object: WorkObject, objects: WorkObject[]): boolean {
  if (object.kind !== "tests" && object.kind !== "command") return false;
  const later = objects.slice(objects.indexOf(object) + 1);
  return later.some((other) => (other.kind === "tests" || other.kind === "command") && other.chip.title === object.chip.title && other.state === "done");
}

/** A folded phase's line of what it came to: its last two outcomes, red when something is still broken. */
export function phaseOutcome(objects: WorkObject[]): Outcome | null {
  const outcomes = objects.flatMap((object) => {
    const outcome = objectOutcome(object);
    return outcome && object.kind !== "edit" && !superseded(object, objects) ? [outcome] : [];
  });
  const texts = [...new Set(outcomes.map((outcome) => outcome.text))].slice(-2);
  return texts.length ? { text: texts.join(" · "), failed: outcomes.some((outcome) => outcome.failed && texts.includes(outcome.text)) } : null;
}

/** The title of a phase named after its calls, when its Git work says it better: "Opened pull request #218". */
export function objectsTitle(objects: WorkObject[]): string | null {
  const git = objects.find((object): object is GitObject => object.kind === "git");
  if (!git) return null;
  const { pullRequest: pr, push } = git;
  if (pr?.state === "failed") return "Tried to open a pull request";
  if (pr?.number) return `Opened pull request #${pr.number}`;
  if (pr) return pr.state === "running" ? "Opening a pull request" : "Tried to open a pull request";
  const branch = git.branch ?? "the branch";
  if (push?.state === "running") return `Pushing ${branch}`;
  if (push) return push.state === "done" ? `Pushed ${branch}` : `Tried to push ${branch}`;
  return git.commits[0] ? `Committed “${git.commits[0].subject}”` : null;
}
