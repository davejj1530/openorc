import { expect, it } from "vitest";
import type { Block } from "./transcript.js";
import { callParts } from "./work-chips.js";

const bash = (command: string, extra: Partial<Extract<Block, { kind: "tool" }>> = {}, description?: string): Block => ({
  id: "b1",
  kind: "tool",
  name: "Bash",
  input: description ? { command, description } : { command },
  done: true,
  at: 1000,
  ...extra,
});

/** Each row as "Section: label · detail · note", the way it reads in the card. */
const rows = (block: Block) => callParts(block).map(({ section, chip }) => [`${section}: ${chip?.label}`, chip?.detail, chip?.note].filter(Boolean).join(" · "));

it("reads David's examples as what they did", () => {
  expect(rows(bash(`grep -n "TopBar\\|settings-sheet\\|className=\\"settings" views/Settings.tsx | head -20`, { output: "12:TopBar\n40:settings-sheet" }))).toEqual([
    'Searched: “TopBar”, “settings-sheet” or “className="settings” · in views/Settings.tsx',
  ]);
  expect(rows(bash(`grep -rn "settings-sheet" --include=*.css . 2>/dev/null | head`))).toEqual(["Searched: “settings-sheet” · *.css"]);
  expect(rows(bash("sed -n 70,100p components/Sidebar.tsx"))).toEqual(["Read: Sidebar.tsx · components · lines 70–100"]);
});

it("lets a read win over the agent's words, and keeps the words as its title", () => {
  const [part] = callParts(bash("sed -n 40,70p packages/db/src/pull-reviews.test.ts", {}, "Read the DB clearDraft test"));
  expect(part).toMatchObject({
    section: "Read",
    chip: { label: "pull-reviews.test.ts", detail: "packages/db/src", note: "lines 40–70", title: "Read the DB clearDraft test" },
  });
});

it("labels a lone described search with the agent's words and shows the query beside them", () => {
  const block = bash(`grep -n "settling\\|reportedWork" packages/agents/src/claude/adapter.ts`, { output: "10:a\n20:b\n30:c\n" }, "Find all background settling references");
  expect(rows(block)).toEqual(["Searched: Find all background settling references · “settling” or “reportedWork” · 3 matches"]);
  expect(callParts(block)[0]?.chip?.live).toBe("Find all background settling references");
});

it("counts matches only for a finished search that nothing cut short", () => {
  const search = `rg -n useWorkSteps src`;
  expect(rows(bash(search, { output: "src/a.ts:1:x\n" }))).toEqual(["Searched: “useWorkSteps” · in src · 1 match"]);
  expect(rows(bash(search, { output: "Exit code 1", isError: true }))).toEqual(["Searched: “useWorkSteps” · in src · no matches"]);
  expect(rows(bash(search, { output: "Exit code 2\nrg: src: No such file", isError: true }))).toEqual(["Searched: “useWorkSteps” · in src"]);
  expect(rows(bash(search, { done: false }))).toEqual(["Searched: “useWorkSteps” · in src"]);
  expect(rows(bash(`${search} | head -5`, { output: "a\nb" }))).toEqual(["Searched: “useWorkSteps” · in src"]);
  // Two searches share one output, so neither can claim its lines.
  expect(rows(bash(`${search}; rg -n other src`, { output: "a\nb" }))).toEqual(["Searched: “useWorkSteps” · in src", "Searched: “other” · in src"]);
});

it("gives a call one Ran row however many steps ran, named by the step that matters", () => {
  expect(rows(bash("mkdir -p /tmp/out && cd /tmp/out && node build.mjs"))).toEqual(["Ran: Run build.mjs"]);
  expect(rows(bash("node build.mjs && cp out.js ../dist"))).toEqual(["Ran: Run build.mjs and copy out.js"]);
  expect(rows(bash("sed -n 1,20p a.ts; pnpm --filter @openorc/desktop test", {}, "Read the helper and run the tests"))).toEqual(["Read: a.ts · lines 1–20", "Ran: Read the helper and run the tests"]);
  expect(rows(bash("echo hi"))).toEqual(["Ran: echo hi"]);
  expect(rows(bash("pnpm exec vitest run src/a.test.ts; pnpm typecheck; ps aux | grep vite"))).toEqual(["Ran: Run the tests and the typecheck"]);
  expect(rows(bash("pnpm exec prettier --write a.cjs && node a.cjs"))).toEqual(["Ran: Format files and run a.cjs"]);
  const [run] = callParts(bash("pnpm --filter @openorc/desktop test"));
  expect(run?.chip).toMatchObject({ label: "Run the tests", live: "Running the tests", detail: "@openorc/desktop", kind: "intent" });
});

it("keeps Codex's own actions, and fills in what they leave out", () => {
  const codex = (command: string, commandActions: object[]): Block => ({
    id: "c1",
    kind: "tool",
    name: "shell",
    input: { command: `/bin/zsh -lc '${command}'`, commandActions },
    done: true,
    at: 1000,
  });
  expect(rows(codex("sed -n 1,45p package.json", [{ type: "read", command: "sed -n 1,45p package.json", name: "package.json", path: "/repo/package.json" }]))).toEqual([
    "Read: package.json · repo · lines 1–45",
  ]);
  expect(rows(codex("ls -la .audit/agent-2", [{ type: "listFiles", command: "ls -la .audit/agent-2", path: "agent-2" }]))).toEqual(["Listed: .audit/agent-2"]);
  expect(rows(codex("git status --short", [{ type: "unknown", command: "git status --short" }]))).toEqual(["Ran: Check git status"]);
  expect(
    rows(
      codex("cat a.md; echo ---", [
        { type: "read", command: "cat a.md", name: "a.md", path: "/repo/a.md" },
        { type: "unknown", command: "echo ---" },
      ]),
    ),
  ).toEqual(["Read: a.md · repo"]);
});

it("gives no count when other steps printed, or when the shell or the search complained", () => {
  expect(rows(bash(`grep -n "—" a.md b.md; echo "em-dash hits: $?"`, { output: "em-dash hits: 1" }))).toEqual(["Searched: “—” · in a.md, b.md"]);
  expect(rows(bash(`grep -rn "OnModuleInit" src --include=*.ts | grep -v "spec.ts"`, { output: "(eval):1: no matches found: --include=*.ts" }))).toEqual(["Searched: “OnModuleInit” · in src, *.ts"]);
  expect(rows(bash(`rg -n 'foo' src 2>&1`, { output: "rg: src: No such file or directory (os error 2)" }))).toEqual(["Searched: “foo” · in src"]);
  expect(rows(bash(`rg -n 'foo' src`, { output: "a\nb" }))).toEqual(["Searched: “foo” · in src · 2 matches"]);
  expect(rows(bash(`rg -n 'foo' src`, { output: "a\nb\nShell cwd was reset to /Users/david/dev/why/designate" }))).toEqual(["Searched: “foo” · in src · 2 matches"]);
});

it("opens a shell read's own call, and links a read Codex resolved to its file", () => {
  expect(callParts(bash("sed -n 70,100p components/Sidebar.tsx"))[0]?.chip?.path).toBeUndefined();
  const codex: Block = {
    id: "c1",
    kind: "tool",
    name: "shell",
    input: { command: "/bin/zsh -lc 'sed -n 1,45p package.json'", commandActions: [{ type: "read", command: "sed -n 1,45p package.json", name: "package.json", path: "/repo/package.json" }] },
    done: true,
    at: 1000,
  };
  expect(callParts(codex)[0]?.chip?.path).toBe("/repo/package.json");
});

it("names up to three plain steps, and keeps each one's past words for a phase title", () => {
  const [run] = callParts(bash("pnpm typecheck && pnpm test && node scripts/size-limit.cjs"));
  expect(run?.chip).toMatchObject({ label: "Run the typecheck, the tests and size-limit.cjs", done: ["Ran the typecheck", "Ran the tests", "Ran size-limit.cjs"] });
});
