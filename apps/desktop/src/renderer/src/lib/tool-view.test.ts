import { expect, it } from "vitest";
import { commandLine } from "./shell";
import type { Block } from "./transcript";
import { printedFile, toolInputView, toolOutputView } from "./tool-view";

const call = (name: string, input: unknown, extra: Partial<Extract<Block, { kind: "tool" }>> = {}): Extract<Block, { kind: "tool" }> => ({ id: "t", kind: "tool", name, input, done: true, ...extra });

it("reads a command as its steps, with the folder it runs in apart", () => {
  expect(toolInputView(call("Bash", { command: "cd /repo/apps/desktop && pnpm test", description: "Run tests" }))).toEqual({
    kind: "command",
    steps: [{ text: "pnpm test", body: null }],
    cwd: "/repo/apps/desktop",
  });
  expect(toolInputView(call("shell", { command: `/bin/zsh -lc "rg -n ThreadStatus src; git status --short"`, cwd: "/repo" }))).toEqual({
    kind: "command",
    steps: [
      { text: "rg -n ThreadStatus src", body: null },
      { text: "git status --short", body: null },
    ],
    cwd: "/repo",
  });
  expect(toolInputView(call("shell", { command: "cd apps && ls", cwd: "/repo" }))).toMatchObject({ cwd: "/repo/apps" });
});

it("shows the script a step feeds in as code in its language", () => {
  const view = toolInputView(call("shell", { command: `/bin/zsh -lc "python3 - <<'PY'\nprint(\\"hi\\")\nPY\ncat > src/a.ts <<'EOF'\nexport const a = 1;\nEOF\nnode -e '\nconsole.log(1)\n' | head"` }));
  expect(view).toEqual({
    kind: "command",
    steps: [
      { text: "python3 -", body: { code: 'print("hi")', language: "py" } },
      { text: "cat > src/a.ts", body: { code: "export const a = 1;", language: "ts" } },
      { text: "node -e | head", body: { code: "console.log(1)", language: "js" } },
    ],
    cwd: null,
  });
});

it("knows the commands that print files, and where the printed lines start", () => {
  const printed = (command: string) => printedFile(commandLine(command));
  expect(printed("sed -n 60,145p components/Transcript.tsx")).toEqual({ paths: ["components/Transcript.tsx"], startLine: 60 });
  expect(printed("sed -n '1,40p' 'src/a b.ts'")).toEqual({ paths: ["src/a b.ts"], startLine: 1 });
  expect(printed("head -n 20 a.ts b.ts")).toEqual({ paths: ["a.ts", "b.ts"], startLine: 1 });
  expect(printed("tail -n 20 logs/app.log")).toEqual({ paths: ["logs/app.log"], startLine: null });
  expect(printed("cat src/a.ts | head -5")).toEqual({ paths: ["src/a.ts"], startLine: 1 });
  expect(printed("cat src/a.ts | sed -n 5,9p")).toEqual({ paths: ["src/a.ts"], startLine: null });
  expect(printed("cat src/a.ts | wc -l")).toBeNull();
});

it("shows a printed file as highlighted code from its first line", () => {
  expect(toolOutputView(call("Bash", { command: "cd /repo && sed -n 60,62p components/Transcript.tsx" }), "a\nb\nc\n")).toEqual({
    kind: "code",
    code: "a\nb\nc",
    language: "tsx",
    startLine: 60,
    path: "components/Transcript.tsx",
  });
  // Claude's Read numbers its lines, an empty last line included; Codex's `nl -ba … | sed` does too.
  const read = toolOutputView(call("Read", { file_path: "/repo/src/work.ts" }), "140\t}\n141\t\n142\tfunction openPhase() {\n143\t\n\n<system-reminder>note</system-reminder>");
  expect(read).toEqual({ kind: "code", code: "}\n\nfunction openPhase() {\n", language: "ts", startLine: 140, path: "/repo/src/work.ts" });
  expect(toolOutputView(call("Read", { file_path: "a.ts" }), "1\tconst a = 1;\n2\t\n")).toMatchObject({ kind: "code", code: "const a = 1;\n" });
  const nl = toolOutputView(call("shell", { command: "nl -ba src/a.py | sed -n '5,6p'", commandActions: [{ type: "read", name: "a.py", path: "src/a.py" }] }), "     5\tx = 1\n     6\ty = 2");
  expect(nl).toMatchObject({ kind: "code", code: "x = 1\ny = 2", language: "py", startLine: 5 });
});

it("reads output from several steps as one only when they print the same kind of thing", () => {
  // Two reads of one CSS file are CSS, without numbers to mislead; a search before a read is neither.
  expect(toolOutputView(call("shell", { command: "sed -n '1,2p' a.css; sed -n '9,9p' a.css" }), "a {}\nb {}\nc {}")).toEqual({
    kind: "code",
    code: "a {}\nb {}\nc {}",
    language: "css",
    startLine: null,
    path: null,
  });
  expect(toolOutputView(call("shell", { command: "rg -n x src; sed -n '1,80p' src/a.ts" }), "src/b.ts:3:x\nconst a = 1;")).toMatchObject({ kind: "text" });
  // A step that prints nothing leaves the output to the one that does.
  expect(toolOutputView(call("shell", { command: "mkdir -p out && cat out/a.json" }), '{"a":1}')).toMatchObject({ kind: "code", language: "json", startLine: 1 });
});

it("groups search output by file and keeps the pattern to mark it", () => {
  const out = "src/a.ts:3:const quiet = agentQuiet();\nsrc/a.ts:9:agentQuiet(x)\nsrc/b.ts:1:import { agentQuiet }";
  expect(toolOutputView(call("Bash", { command: "rg -n agentQuiet src", description: "Find it" }), out)).toEqual({
    kind: "matches",
    pattern: "agentQuiet",
    groups: [
      {
        path: "src/a.ts",
        lines: [
          { line: 3, text: "const quiet = agentQuiet();" },
          { line: 9, text: "agentQuiet(x)" },
        ],
      },
      { path: "src/b.ts", lines: [{ line: 1, text: "import { agentQuiet }" }] },
    ],
  });
  expect(toolOutputView(call("Bash", { command: "rg agentQuiet" }), "src/a.ts:const a\nsrc/b.ts:const b")).toMatchObject({
    kind: "matches",
    groups: [{ path: "src/a.ts", lines: [{ line: null }] }, { path: "src/b.ts" }],
  });
  expect(toolOutputView(call("Grep", { pattern: "x", output_mode: "content", path: "src/a.ts" }), "4:let x\n8:x()")).toMatchObject({
    kind: "matches",
    groups: [{ path: "src/a.ts", lines: [{ line: 4 }, { line: 8 }] }],
    pattern: "x",
  });
});

it("reads one file's search and the lines around its matches", () => {
  expect(toolOutputView(call("Bash", { command: `grep -n "html\\|case" MarkdownManager.ts | head -120` }), "36:import { html }\n163:    case 'a':")).toMatchObject({
    kind: "matches",
    pattern: "html|case",
    groups: [{ path: "MarkdownManager.ts", lines: [{ line: 36 }, { line: 163 }] }],
  });
  expect(toolOutputView(call("shell", { command: "rg -n -A1 WorkspaceMode src" }), "src/a.ts:50:type WorkspaceMode = 1;\nsrc/a.ts-51-\n--\nsrc/b.ts:2:WorkspaceMode")).toMatchObject({
    kind: "matches",
    groups: [{ path: "src/a.ts", lines: [{ line: 50 }, { line: 51, text: "", context: true }] }, { path: "src/b.ts" }],
  });
  // Filtered on the way out, or several searches in a row, the lines still say where they are from.
  expect(toolOutputView(call("Bash", { command: `grep -rn "a\\|b" . | grep -v test | cut -c1-200` }), "./x.ts:1:a\n./y.ts:2:b")).toMatchObject({ kind: "matches", pattern: "a|b" });
  expect(toolOutputView(call("shell", { command: "rg -n foo src; rg -n bar lib" }), "src/a.ts:1:foo\nlib/b.ts:2:bar")).toMatchObject({
    kind: "matches",
    pattern: "foo|bar",
    groups: [{ path: "src/a.ts" }, { path: "lib/b.ts" }],
  });
  expect(toolOutputView(call("Bash", { command: "grep -n -A2 WorkspaceMode packages/*.ts" }), "packages/a.ts:50:type WorkspaceMode\npackages/a.ts-51-")).toMatchObject({
    kind: "matches",
    groups: [{ path: "packages/a.ts" }],
  });
  expect(toolOutputView(call("shell", { command: "rg needle notes.md" }), "a needle\nanother needle")).toMatchObject({
    kind: "matches",
    groups: [{ path: "notes.md", lines: [{ line: null, text: "a needle" }, { line: null }] }],
  });
});

it("lists files from file searches and listings", () => {
  expect(toolOutputView(call("Grep", { pattern: "x" }), "Found 2 files limit: 20\n/repo/a.ts\n/repo/b.tsx")).toEqual({ kind: "files", paths: ["/repo/a.ts", "/repo/b.tsx"] });
  expect(toolOutputView(call("shell", { command: "rg --files src" }), "src/a.ts\nsrc/b/c.css")).toEqual({ kind: "files", paths: ["src/a.ts", "src/b/c.css"] });
  expect(toolOutputView(call("shell", { command: "grep -rl needle src" }), "src/a.ts\nsrc/b.ts")).toEqual({ kind: "files", paths: ["src/a.ts", "src/b.ts"] });
});

it("reads git status as what happened to each file", () => {
  const status = " M src/app.module.ts\nA  src/new.ts\n D old.ts\nR  a.ts -> b.ts\n?? src/consulting/\nUU both.ts";
  expect(toolOutputView(call("shell", { command: "git diff --check; git status --short" }), status)).toEqual({
    kind: "changes",
    files: [
      { path: "src/app.module.ts", status: "modified" },
      { path: "src/new.ts", status: "added" },
      { path: "old.ts", status: "deleted" },
      { path: "b.ts", status: "renamed" },
      { path: "src/consulting/", status: "untracked" },
      { path: "both.ts", status: "conflict" },
    ],
  });
  expect(toolOutputView(call("shell", { command: "git status --short; echo done" }), " M a.ts\ndone")).toMatchObject({ kind: "text" });
});

it("shows diffs, JSON, test runs and agent reports as themselves, and anything else as text", () => {
  expect(toolOutputView(call("Bash", { command: "git diff" }), "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b")).toMatchObject({ kind: "diff" });
  expect(toolOutputView(call("mcp__openorc__task_get", { id: "t" }), '{"id":"t","status":"done"}')).toEqual({ kind: "json", json: '{\n  "id": "t",\n  "status": "done"\n}' });
  expect(toolOutputView(call("Bash", { command: "pnpm test 2>&1 | tail -3" }), "\u001b[32m      Tests  48 passed (48)\u001b[0m")).toMatchObject({ kind: "tests", tally: { passed: 48 } });
  expect(toolOutputView(call("Task", { prompt: "Look", description: "Explore" }), "## Findings\n- one")).toEqual({ kind: "markdown", text: "## Findings\n- one" });
  expect(toolOutputView(call("Bash", { command: "echo hi" }), "hi\n")).toEqual({ kind: "text", text: "hi" });
  expect(toolOutputView(call("Bash", { command: "echo" }), "  \n")).toBeNull();
});

it("shows what a call was asked in the shape of its kind", () => {
  expect(toolInputView(call("Read", { file_path: "/repo/a.ts", offset: 60, limit: 20 }))).toEqual({ kind: "file", path: "/repo/a.ts", lines: "lines 60–79" });
  expect(toolInputView(call("Read", { file_path: "/repo/a.ts", offset: 60 }))).toEqual({ kind: "file", path: "/repo/a.ts", lines: "from line 60" });
  expect(toolInputView(call("Edit", { file_path: "a.ts", old_string: "a", new_string: "b" }))).toEqual({ kind: "edit", path: "a.ts", before: "a", after: "b" });
  expect(toolInputView(call("Write", { file_path: "a.md", content: "# Hi" }))).toEqual({ kind: "write", path: "a.md", content: "# Hi" });
  expect(toolInputView(call("Grep", { pattern: "x", path: "src", "-i": true, glob: "*.ts" }))).toEqual({ kind: "search", pattern: "x", scope: "src", flags: ["ignore case", "*.ts"] });
  expect(toolInputView(call("WebFetch", { url: "https://example.com", prompt: "Read" }))).toEqual({ kind: "web", target: "https://example.com" });
  expect(toolInputView(call("Task", { prompt: "Map the repo", subagent_type: "Explore" }))).toEqual({ kind: "prompt", text: "Map the repo", agent: "Explore" });
  expect(toolInputView(call("mcp__claude_ai_Mobbin__search_screens", { query: "onboarding", limit: 8, platform: null }))).toEqual({
    kind: "fields",
    fields: [
      { key: "query", value: "onboarding", structured: false },
      { key: "limit", value: "8", structured: false },
    ],
  });
  expect(toolInputView(call("apply_patch", [{ path: "a.ts", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b" }]))).toMatchObject({ kind: "patch" });
});
