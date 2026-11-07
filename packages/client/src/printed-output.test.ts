import { expect, it } from "vitest";
import { printedOutput } from "./printed-output.js";

it("reads dividers as headings, failures and warnings by tone, and paths at a line's start as links", () => {
  const text = [
    "Exit code 1",
    "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
    "      Tests  1 failed | 59 skipped (60)",
    "      Tests  767 passed (767)",
    "[warn] Code style issues found in the above file. Run Prettier with --write to fix.",
    "src/connection/manager.ts:42:  const why = route.why;",
    "src/a.ts(12,5): error TS2345: Argument of type",
    "=====",
    "Shell cwd was reset to /Users/you/dev/openorc",
  ].join("\n");
  const { exit, lines } = printedOutput(text);
  expect(exit).toBe(1);
  expect(lines.map((line) => (line.kind === "rule" ? `rule:${line.text}` : `${line.tone ?? "-"}${line.ref ? `:${line.ref.path}@${line.ref.line}` : ""}`))).toEqual([
    "rule:Failed Tests 1",
    "bad",
    "-",
    "warn",
    "-:src/connection/manager.ts@42",
    "bad:src/a.ts@12",
    "rule:",
    "note",
  ]);
  const ref = lines[4]!.kind === "line" ? lines[4]!.ref! : null;
  expect(text.split("\n")[5]!.slice(ref!.start, ref!.end)).toBe("src/connection/manager.ts:42");
});

it("has no lines when the command printed nothing, and links no words that only look like files", () => {
  expect(printedOutput("(Bash completed with no output)")).toEqual({ exit: null, lines: [] });
  expect(printedOutput("Exit code 2\n")).toEqual({ exit: 2, lines: [] });
  const [line] = printedOutput("node.js is installed; 0 failed, 0 errors").lines;
  expect(line).toEqual({ kind: "line", text: "node.js is installed; 0 failed, 0 errors", tone: null, ref: null });
});
