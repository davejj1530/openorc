import type { AgentEvent } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import calls from "./test-fixtures/work-calls.json";
import { applyEvents, emptyRun, type Block } from "./transcript.js";
import { passageProofs, proofLabel, proofNames, proofOf, replyMarks, turnEvidence, type ProofNames } from "./turn-proof.js";

/** Real calls recorded from the agents, replayed into blocks the way a transcript reads them. */
function replay(...labels: string[]): Block[] {
  const run = emptyRun("r");
  for (const label of labels) {
    const entry = calls.find((call) => call.label === label || call.label.startsWith(label));
    if (!entry) throw new Error(`No recorded call "${label}"`);
    applyEvents(run, entry.events.map((event) => ({ ...event, runId: "r" })) as AgentEvent[]);
  }
  return run.blocks;
}

const edit = (id: string, path: string, before = "a", after = "b\nc"): Block => ({
  id,
  kind: "tool",
  name: "Edit",
  input: { file_path: path, old_string: before, new_string: after },
  output: "ok",
  done: true,
});
const bash = (id: string, command: string, extra: Partial<Extract<Block, { kind: "tool" }>> = {}): Block => ({
  id,
  kind: "tool",
  name: "Bash",
  input: { command },
  output: "",
  done: true,
  isError: false,
  ...extra,
});

const names = (given: Partial<ProofNames>): ProofNames => ({ files: [], checks: [], unrun: [], ...given });

describe("turnEvidence", () => {
  it("holds each file the turn changed once, with every edit to it, and the last run of each check", () => {
    const work = [edit("e1", "src/Row.tsx"), bash("t1", "npx tsc --noEmit"), edit("e2", "src/Row.tsx"), edit("e3", "src/List.tsx"), ...replay("vitest run passing (tail)")];
    const evidence = turnEvidence(work);
    expect(evidence.files.map((file) => [file.path, file.edits.length])).toEqual([
      ["src/Row.tsx", 2],
      ["src/List.tsx", 1],
    ]);
    expect(evidence.checks.map((check) => [check.check, check.outcome, check.stale])).toEqual([
      ["typecheck", "passed", true],
      ["tests", "passed", false],
    ]);
    expect(proofLabel(proofOf(evidence, "check:typecheck")!)).toEqual({ text: "Typecheck passed before the last edit", tone: null });
    expect(proofLabel(proofOf(evidence, "check:tests")!).tone).toBe("ok");
    expect(proofLabel(proofOf(evidence, "file:src/Row.tsx")!).text).toMatch(/^Row\.tsx \+\d+ −\d+$/);
    expect(proofLabel(proofOf(evidence, "changes")!).text).toMatch(/^2 files \+/);
  });

  it("keeps a run standing through an edit to words alone", () => {
    const evidence = turnEvidence([edit("e1", "src/Row.tsx"), bash("t1", "npx tsc --noEmit"), edit("e2", "docs/notes.md")]);
    expect(proofLabel(proofOf(evidence, "check:typecheck")!)).toEqual({ text: "Typecheck passed", tone: "ok" });
  });

  it("reads a failed check as failed, and one piped away as only having run", () => {
    const failed = turnEvidence([bash("t", "pnpm lint", { isError: true, status: "error" })]);
    expect(proofLabel(proofOf(failed, "check:lint")!)).toEqual({ text: "Lint failed", tone: "bad" });
    const piped = turnEvidence([bash("t", "npx tsc --noEmit | tail -5")]);
    expect(proofLabel(proofOf(piped, "check:typecheck")!)).toEqual({ text: "Typecheck ran", tone: null });
  });

  it("calls a check unrun only when nothing the turn ran could have been it", () => {
    expect(turnEvidence([edit("e", "a.ts"), bash("g", "git status")]).unrun).toEqual(["tests", "typecheck", "lint", "build"]);
    // A script of the project's may be its tests under another name.
    expect(turnEvidence([edit("e", "a.ts"), bash("m", "make check")]).unrun).toEqual([]);
    expect(turnEvidence([edit("e", "a.ts"), bash("s", "./scripts/run-tests.sh")]).unrun).toEqual(["typecheck", "lint", "build"]);
    expect(turnEvidence([edit("e", "a.ts"), bash("a", "", { name: "Task", subagent: {} as never })]).unrun).toEqual([]);
    // A look at a test file is not a run of the tests.
    expect(turnEvidence([edit("e", "a.ts"), bash("r", "sed -n '1,40p' src/row.test.ts")]).unrun).toContain("tests");
    // A turn that changed nothing may be telling of a run from an earlier turn.
    expect(turnEvidence([bash("g", "git status")]).unrun).toEqual([]);
  });
});

describe("passageProofs", () => {
  const two = names({ files: ["src/list/Row.tsx", "src/grid/Row.tsx", "src/App.tsx"], checks: ["tests"], unrun: ["typecheck", "lint", "build"] });

  it("takes a file where its name stands whole, by as much of its path as tells it from the others", () => {
    expect(passageProofs("Guarded the first row in `src/App.tsx:42`.", two)).toEqual(["file:src/App.tsx"]);
    expect(passageProofs("App.tsx.bak is untouched, and so is MyApp.tsx", two)).toEqual([]);
    expect(passageProofs("Both rows changed: list/Row.tsx first.", two)).toEqual(["file:src/list/Row.tsx"]);
    expect(passageProofs("Row.tsx changed.", two)).toEqual(["changes"]);
    // "changes" and "fixes" are as often things as deeds.
    expect(passageProofs("No tracked changes by me.", two)).toEqual([]);
  });

  it("takes the change as a whole for a sentence that says so and names no file, the one file where there is one", () => {
    expect(passageProofs("Fixed: a read that has only just started no longer blanks the page.", two)).toEqual(["changes"]);
    expect(passageProofs("The crash is fixed.", names({ files: ["src/App.tsx"] }))).toEqual(["file:src/App.tsx"]);
    expect(passageProofs("Should I have changed it?", two)).toEqual([]);
    expect(passageProofs("Here is how it works.", two)).toEqual([]);
    // A deed told further in, or in an aside, is not what the passage is for.
    expect(passageProofs("Verified sign-in and invitations. Scratch resources are removed.", two)).toEqual([]);
    expect(passageProofs("Chat (the heart was added from the phone):", two)).toEqual([]);
    // Notes alone are not the change a sentence speaks of.
    expect(passageProofs("The phone app is fixed.", names({ files: ["notes/unit-4.md"] }))).toEqual([]);
    expect(passageProofs("Wrote it up in `notes/unit-4.md`.", names({ files: ["notes/unit-4.md"] }))).toEqual(["file:notes/unit-4.md"]);
  });

  it("takes a check where the sentence speaks of how it came out", () => {
    expect(passageProofs("All the tests pass.", two)).toEqual(["check:tests"]);
    expect(passageProofs("I ran the tests.", two)).toEqual(["check:tests"]);
    expect(passageProofs("The tests should pass now.", two)).toEqual(["check:tests"]);
    expect(passageProofs("I wrote tests for the empty list.", two)).toEqual([]);
  });

  it("calls out a check the turn never ran only under a plain claim that it passed", () => {
    expect(passageProofs("Typecheck and lint are clean.", two)).toEqual(["missing:typecheck", "missing:lint"]);
    expect(passageProofs("I have not run the typecheck, so it may not pass.", two)).toEqual([]);
    expect(passageProofs("Run the build to confirm it passes if you like.", two)).toEqual([]);
    expect(passageProofs("I will clean up the lint next.", two)).toEqual([]);
    expect(passageProofs("The build passes.", names({ checks: [], unrun: [] }))).toEqual([]);
    // Each sentence is read by itself.
    expect(passageProofs("The race test failed first, then passed. All 12 tests pass and the core typechecks.", names({ unrun: ["tests", "typecheck"] }))).toEqual([
      "missing:tests",
      "missing:typecheck",
    ]);
  });
});

describe("replyMarks", () => {
  const known = names({ files: ["src/App.tsx", "src/Row.tsx"], checks: ["tests"], unrun: ["typecheck"] });

  it("puts each proof on the first line that calls on it, and on no line twice", () => {
    const reply = [
      "The crash is fixed.",
      "",
      "- `src/App.tsx`: guard the first row",
      "- `src/Row.tsx`: same guard",
      "- `src/App.tsx` again, for the header",
      "",
      "Tests pass, and typecheck is clean. Tests pass.",
    ].join("\n");
    expect(replyMarks(reply, known)).toEqual([
      { key: "changes", line: "The crash is fixed." },
      { key: "file:src/App.tsx", line: "- `src/App.tsx`: guard the first row" },
      { key: "file:src/Row.tsx", line: "- `src/Row.tsx`: same guard" },
      { key: "check:tests", line: "Tests pass, and typecheck is clean. Tests pass." },
      { key: "missing:typecheck", line: "Tests pass, and typecheck is clean. Tests pass." },
    ]);
  });

  it("leaves code blocks, headings and tables alone", () => {
    const reply = ["## Tests pass", "```sh", "pnpm test # tests pass", "```", "| tests | pass |", "The tests pass."].join("\n");
    expect(replyMarks(reply, known)).toEqual([{ key: "check:tests", line: "The tests pass." }]);
  });

  it("marks nothing in a reply of a turn that did nothing a sentence could call on", () => {
    expect(replyMarks("The tests pass.", names({}))).toEqual([]);
  });
});

it("names what the turn holds by name alone", () => {
  // `tsc` may be the project's build as well as its typecheck, so a build is not called unrun.
  expect(proofNames(turnEvidence([edit("e", "src/App.tsx"), bash("t", "npx tsc --noEmit")]))).toEqual({ files: ["src/App.tsx"], checks: ["typecheck"], unrun: ["tests", "lint"] });
});
