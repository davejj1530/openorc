import { expect, it } from "vitest";
import { readStep } from "./command-steps.js";
import { shellSteps } from "./shell.js";

const said = (text: string) => {
  const { label, detail, plumbing } = readStep(text);
  return { label, detail, plumbing: plumbing === null ? null : text.slice(plumbing) };
};

it("reads each step of a chain in plain words, with the plumbing that trims its output apart", () => {
  const command =
    'cp src/connection/manager.ts /tmp/manager-new.ts && git show HEAD:apps/mobile/src/connection/manager.ts > src/connection/manager.ts && npx vitest run --maxWorkers=2 src/connection/manager.test.ts -t "only" 2>&1 | grep -E "Tests " | head -3; npx tsc --noEmit -p tsconfig.json 2>&1 | tail -3; npx eslint --max-warnings=0 src/a.ts 2>&1 | tail -3; npx prettier --check src/a.ts';
  expect(shellSteps(command).map((step) => said(step.text))).toEqual([
    { label: "Copy manager.ts", detail: null, plumbing: null },
    { label: "Write manager.ts", detail: null, plumbing: null },
    { label: "Run the tests", detail: "manager.test.ts", plumbing: ' 2>&1 | grep -E "Tests " | head -3' },
    { label: "Run the typecheck", detail: "tsconfig.json", plumbing: " 2>&1 | tail -3" },
    { label: "Run lint", detail: null, plumbing: " 2>&1 | tail -3" },
    { label: "Check formatting", detail: null, plumbing: null },
  ]);
});

it("keeps a search's pipe as part of what it looked for, and leaves unknown commands unnamed", () => {
  expect(said("rg -n useTheme src | head -20")).toMatchObject({ label: "Search “useTheme”", plumbing: null });
  expect(said("sed -n 1,60p apps/brain/src/line.ts")).toMatchObject({ label: "Read line.ts", detail: "lines 1–60" });
  expect(said("xcrun simctl list runtimes 2>/dev/null")).toEqual({ label: null, detail: null, plumbing: " 2>/dev/null" });
  expect(said("# check the bundle")).toEqual({ label: null, detail: null, plumbing: null });
  // A pipe into something that changes what the output means is not plumbing.
  expect(said("git log --oneline | wc -l").plumbing).toBeNull();
});
