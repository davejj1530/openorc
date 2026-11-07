import { expect, it } from "vitest";
import { gitStatus, numberedCode, testTally } from "./tool-text.js";

it("reads a test run's tally from vitest, jest, pytest and cargo", () => {
  expect(testTally(" Test Files  1 failed | 180 passed (181)\n      Tests  2 failed | 1015 passed (1017)")).toEqual({ passed: 1015, failed: 2, skipped: 0 });
  expect(testTally("Tests:       1 failed, 20 passed, 21 total")).toEqual({ passed: 20, failed: 1, skipped: 0 });
  expect(testTally("===== 3 failed, 10 passed, 1 skipped in 2.31s =====")).toEqual({ passed: 10, failed: 3, skipped: 1 });
  expect(testTally("test result: ok. 12 passed; 0 failed; 2 ignored; 0 measured")).toEqual({ passed: 12, failed: 0, skipped: 2 });
  // A command that ran the tests twice reads as its newest run, as the work view does.
  expect(testTally("      Tests  1 failed | 59 skipped (60)\n Test Files  123 passed (123)\n      Tests  767 passed (767)")).toEqual({ passed: 767, failed: 0, skipped: 0 });
});

it("takes only what is wholly numbered code or wholly git status", () => {
  expect(numberedCode("<system-reminder>The file is empty.</system-reminder>")).toBeNull();
  expect(numberedCode("1\ta\nnot numbered")).toBeNull();
  expect(gitStatus("## main...origin/main\n M a.ts")).toEqual([{ path: "a.ts", status: "modified" }]);
  expect(gitStatus(" M a.ts\nnothing to commit")).toBeNull();
});
