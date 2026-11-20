import { expect, it } from "vitest";
import { commandWords, outputLines, shortPath } from "./command-words.js";

const base = "/Users/ana/dev/app";

it("separates where a command ran from what it ran", () => {
  expect(commandWords(`cd ${base}/apps/desktop && pnpm test`, base)).toEqual({ command: "pnpm test", folder: "apps/desktop" });
  expect(commandWords(`cd ${base} && git status`, base)).toEqual({ command: "git status", folder: null });
  expect(commandWords(`cd "/Users/ana/Library/Application Support/App/worktrees/x-1/thread-a" && ls`, base)).toEqual({ command: "ls", folder: "…/x-1/thread-a" });
});

it("cuts machine paths inside a command to what tells them apart", () => {
  expect(commandWords(`cat ${base}/src/a.ts /Users/ana/notes.md`, base).command).toBe("cat src/a.ts ~/notes.md");
  expect(commandWords("grep -n /Users src/x.ts").command).toBe("grep -n /Users src/x.ts");
});

it("shows a command that only goes somewhere as written", () => {
  expect(commandWords("cd /Users/ana/dev/app")).toEqual({ command: "cd ~/dev/app", folder: null });
});

it("writes a path from the project, or from the home folder", () => {
  expect(shortPath(`${base}/src/a.ts`, base)).toBe("src/a.ts");
  expect(shortPath("/Users/ana/.claude/plans/p.md", base)).toBe("~/.claude/plans/p.md");
  expect(shortPath("src/a.ts", base)).toBe("src/a.ts");
});

it("reads output lines as passes and failures, without colour codes", () => {
  const { lines, hidden } = outputLines("\u001b[32m ✓ a.test.ts\u001b[0m\n ✗ b.test.ts\n Tests  0 failed | 3 passed\nplain\n", 3);
  expect(hidden).toBe(1);
  expect(lines).toEqual([
    { text: " ✗ b.test.ts", tone: "bad" },
    { text: " Tests  0 failed | 3 passed", tone: "ok" },
    { text: "plain", tone: null },
  ]);
});
