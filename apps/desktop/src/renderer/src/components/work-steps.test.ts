import { expect, it } from "vitest";
import type { Block } from "../lib/transcript";
import { liveHeadline, narrationTitle, reasoningSections, workEntries, type WorkEntry } from "./work-steps";
import { callParts, chipCalls } from "./work-chips";
import { turnReceipt } from "./work-receipt";

const tool = (id: string, name: string, input: unknown, done = true, extra: Partial<Extract<Block, { kind: "tool" }>> = {}): Block => ({ id, kind: "tool", name, input, done, at: 1000, ...extra });
const thinking = (id: string, text: string, live = false): Block => ({ id, kind: "thinking", text, startedAt: 500, endedAt: live ? null : 900 });
const activity = (id: string, label: string, status: "running" | "success" = "success", text = ""): Block => ({ id, kind: "activity", label, status, text, at: 1000 });
const narration = (id: string, text: string, streaming = false): Block => ({ id, kind: "message", role: "assistant", text, streaming, at: 800 });
const shell = (id: string, command: string, actions: object[], done = true) => tool(id, "shell", { command, commandActions: actions }, done);

/** Each entry as readable lines: "#" a phase the agent named, "~" one named after its calls, then its groups. */
function outline(entries: WorkEntry[]): string[] {
  return entries.flatMap((entry) => {
    if (entry.kind === "plan") return [`plan ${entry.items.map((item) => `${item.status}:${item.text}`).join(", ")}`];
    if (entry.kind === "blocks") return [`blocks ${entry.blocks.map((block) => block.id).join(",")}`];
    const { phase } = entry;
    const chip = (c: { label: string; added?: number; removed?: number }) => `[${c.label}${c.added ? ` +${c.added}` : ""}${c.removed ? ` -${c.removed}` : ""}]`;
    return [
      `${phase.origin === "summary" ? "~" : "#"} ${phase.title}`,
      ...phase.sections.map((section) => `  ${section.label}: ${section.chips.map(chip).join(" ")}`.trimEnd()),
      ...(phase.extras.length ? [`  + ${phase.extras.map((block) => block.id).join(",")}`] : []),
    ];
  });
}

it("splits Codex reasoning into titled sections and keeps each body", () => {
  expect(reasoningSections("**Inspecting the row**\n\nI need the status code.\n\n**Planning the edit**\n\nSmall change.\n\nStill planning.")).toEqual([
    { title: "Inspecting the row", body: "I need the status code." },
    { title: "Planning the edit", body: "Small change.\n\nStill planning." },
  ]);
  expect(reasoningSections("Plain reasoning without a heading")).toEqual([]);
});

it("titles a phase with the sentence of the narration that says what comes next", () => {
  expect(narrationTitle("Reading the task editor code to find the bug.")).toBe("Reading the task editor code to find the bug");
  expect(narrationTitle("Fonts installed. Briefing the asset thread on the new files.")).toBe("Briefing the asset thread on the new files");
  expect(narrationTitle("I've read the full 34-page guide. Now mapping the components.")).toBe("Mapping the components");
  expect(narrationTitle("Committing only my files, split by topic. The rest stays.")).toBe("Committing only my files, split by topic");
  expect(narrationTitle("Checking **`agentQuiet`** in [the row](src/row.tsx).")).toBe("Checking agentQuiet in the row");
  expect(narrationTitle("The core keeps the thread running while a command lives. Checking the ledger to confirm.")).toBe("Checking the ledger to confirm");
  expect(narrationTitle("The tests ran clean against the new parser. Nothing else changed.")).toBe("The tests ran clean against the new parser");
  expect(narrationTitle("Let me look at the comp carefully.")).toBe("Look at the comp carefully");
  expect(narrationTitle("The row only shows an icon today. I'll put the quiet time beside it.")).toBe("Put the quiet time beside it");
  expect(narrationTitle("I’ll start by exploring the project structure.")).toBe("Exploring the project structure");
  expect(narrationTitle("Immaculate is available. I'm using it with the design guide.")).toBe("Using it with the design guide");
});

it("heads Codex work with its reasoning titles and groups what each phase touched", () => {
  const blocks = [
    thinking("r1", "**Inspecting the status row**\n\nFind where the row renders."),
    shell("c1", "rg --files src && rg 'ThreadStatus'", [
      { type: "listFiles", command: "rg --files src", path: "src" },
      { type: "search", command: "rg 'ThreadStatus'", query: "ThreadStatus" },
    ]),
    shell("c2", "sed -n 1,40p src/status.tsx", [{ type: "read", command: "sed -n 1,40p src/status.tsx", name: "status.tsx", path: "src/status.tsx" }]),
    shell("c3", "rg agentQuiet", [{ type: "search", command: "rg agentQuiet", query: "agentQuiet" }]),
    thinking("r2", "**Updating the row**"),
    tool("p1", "apply_patch", [{ path: "src/ThreadStatusIndicator.tsx", kind: "update", diff: "@@ -1,2 +1,3 @@\n-a\n+b\n+c" }]),
    shell("c4", "pnpm test", [{ type: "unknown", command: "pnpm test" }]),
  ];
  expect(outline(workEntries(blocks))).toEqual([
    "# Inspecting the status row",
    "  Listed: [src]",
    "  Searched: [ThreadStatus] [agentQuiet]",
    "  Read: [status.tsx]",
    "# Updating the row",
    "  Edited: [ThreadStatusIndicator.tsx +2 -1]",
    "  Ran: [pnpm test]",
  ]);
  const [first] = workEntries(blocks);
  expect(first?.kind === "phase" && first.phase.detail).toBe("Find where the row renders.");
});

it("keeps Codex's reasoning titles from splitting the work into a phase per call", () => {
  // Titles with no call between them fold into the next title, as the steps that led there.
  const folded = workEntries([thinking("r1", "**Reading the comp**\n\n**Checking the guide**"), thinking("r2", "**Capturing references**"), tool("c1", "shell", { command: "ls" })]);
  expect(outline(folded)).toEqual(["# Capturing references", "  Ran: [ls]"]);
  expect(folded[0]?.kind === "phase" && folded[0].phase.thoughts.map((thought) => thought.title)).toEqual(["Reading the comp", "Checking the guide"]);
  // Inside a narrated phase, titles are its steps rather than phases of their own.
  const narrated = workEntries([
    narration("n1", "I'll study the opening sequence."),
    thinking("r1", "**Scrolling 680 pixels**"),
    tool("b1", "openorc.browser", { action: "scroll" }),
    thinking("r2", "**Capturing the hero**"),
    tool("b2", "openorc.browser", { action: "screenshot" }),
  ]);
  expect(outline(narrated)).toEqual(["# Study the opening sequence", "  Used OpenOrc: [browser]"]);
  expect(narrated[0]?.kind === "phase" && narrated[0].phase.thoughts.map((thought) => thought.title)).toEqual(["Scrolling 680 pixels", "Capturing the hero"]);
  expect(liveHeadline(narrated, [narration("n1", "I'll study the opening sequence."), thinking("r3", "**Comparing the frames**", true)])).toMatchObject({ entryId: "phase-n1" });
});

it("opens Claude's phases at its narration and names earlier calls after what they did", () => {
  const blocks = [
    tool("t1", "Read", { file_path: "/repo/src/a.ts" }),
    tool("t2", "Read", { file_path: "/repo/src/b.ts" }),
    tool("t3", "Grep", { pattern: "agentQuiet" }),
    narration("n1", "Found the row. Now checking where threads are marked running."),
    tool("t4", "Bash", { command: "rg -n running packages/core", description: "Find where threads are marked running" }),
    tool("t5", "Read", { file_path: "/repo/src/c.ts" }),
    tool("t6", "Edit", { file_path: "/repo/src/d.ts", old_string: "keep\nold\nkeep", new_string: "keep\nnew\nkeep" }),
    tool("t7", "Bash", { command: "pnpm test", description: "Run the desktop tests" }),
    tool("t8", "mcp__claude_ai_Figma__get_design_context", {}),
  ];
  expect(outline(workEntries(blocks))).toEqual([
    "~ Read 2 files, searched once",
    "  Read: [a.ts] [b.ts]",
    "  Searched: [agentQuiet]",
    "# Checking where threads are marked running",
    "  Ran: [Find where threads are marked running] [Run the desktop tests]",
    "  Read: [c.ts]",
    "  Edited: [d.ts +1 -1]",
    "  Used Figma: [get design context]",
  ]);
});

it("names a phase with one described command after it, and shows a raw command by its first line", () => {
  expect(outline(workEntries([tool("t1", "Bash", { command: "pnpm test", description: "Run the desktop tests" })]))).toEqual(["~ Run the desktop tests", "  Ran: [Run the desktop tests]"]);
  const raw = [tool("c1", "shell", { command: `/bin/zsh -lc "python3 - <<'PY'\nprint(1)\nPY"` }), tool("c2", "shell", { command: "git status --short" })];
  expect(outline(workEntries(raw))).toEqual(["~ Ran 2 commands", "  Ran: [python3 -] [git status --short]"]);
});

it("drops waiting and startup signals, keeps reasoning with the call it led to, and keeps milestones in their phase", () => {
  const blocks = [
    activity("activity-startup", "Starting Claude Code"),
    activity("activity-request-1", "Waiting for Claude"),
    thinking("empty", ""),
    thinking("why", "The row needs the quiet time."),
    tool("t1", "Read", { file_path: "src/a.ts" }),
    tool("send", "openorc.thread_send", { target: "assets", text: "Done" }),
    narration("n1", "Now the edit."),
    thinking("after", "Checking the result."),
  ];
  const entries = workEntries(blocks);
  expect(outline(entries)).toEqual(["~ Read a file", "  Read: [a.ts]", "  + send", "# The edit", "blocks after"]);
  expect(entries[0]?.kind === "phase" && entries[0].phase.sections[0]!.blocks.map((block) => block.id)).toEqual(["empty", "why", "t1"]);
  expect(outline(workEntries(blocks, true, "send"))).toEqual(["~ Read a file", "  Read: [a.ts]", "blocks send", "# The edit", "blocks after"]);
});

it("opens an edit chip to its own file's part of a patch, so the diff is the one its numbers count", () => {
  const patch = tool("p1", "apply_patch", [
    { path: "src/a.ts", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b" },
    { path: "src/b.ts", kind: "add", diff: "+c" },
  ]);
  const [first] = callParts(patch);
  expect(first?.chip).toMatchObject({ kind: "edit", path: "src/a.ts", added: 1, removed: 1 });
  const calls = chipCalls({ ...first!.chip!, blocks: [patch] });
  expect(calls.map((block) => block.kind === "tool" && block.input)).toEqual([[{ path: "src/a.ts", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b" }]]);
  expect(callParts(tool("r1", "Read", { file_path: "src/a.ts" }))[0]?.chip).toMatchObject({ kind: "file", path: "src/a.ts" });
});

it("still shows a turn that only started or only thought", () => {
  expect(outline(workEntries([activity("activity-startup", "Starting OpenCode")]))).toEqual(["blocks activity-startup"]);
  expect(outline(workEntries([thinking("lone", "")]))).toEqual(["blocks lone"]);
});

it("turns Codex plan updates and Claude todos into checklists", () => {
  const plan = activity("activity-plan-turn", "Plan", "running", "Ship the row\ncompleted: Inspect\nin_progress: Edit\npending: Test");
  const todos = tool("todo", "TodoWrite", { todos: [{ content: "Inspect", status: "completed", activeForm: "Inspecting" }] });
  expect(outline(workEntries([plan, todos]))).toEqual(["plan completed:Inspect, in_progress:Edit, pending:Test", "plan completed:Inspect"]);
});

it("names the one thing happening now, wherever it sits", () => {
  const head = (blocks: Block[], turn = blocks) => liveHeadline(workEntries(blocks), turn);
  expect(head([thinking("r1", "**Running the tests**"), tool("c1", "shell", { command: "pnpm test" }, false)])).toMatchObject({ label: "Running the tests", entryId: "phase-r1", since: 500 });
  expect(head([narration("n1", "I'll study the opening."), thinking("r1", "**Scrolling to the logos**", true)])).toMatchObject({ label: "Scrolling to the logos", entryId: "phase-n1" });
  expect(head([tool("c1", "shell", { command: "pnpm test" }, false)])).toMatchObject({ label: "Running pnpm test", entryId: "phase-c1" });
  expect(head([tool("c1", "Bash", { command: "pnpm test", description: "Run the tests" }, false)])).toMatchObject({ label: "Run the tests" });
  expect(head([narration("n1", "Checking the ledger."), tool("c1", "Bash", { command: "sqlite3", description: "Read the ledger" }, false)])).toMatchObject({
    label: "Checking the ledger",
    since: 800,
  });
  // Between calls the newest phase keeps the line, so nothing folds and reopens on every call.
  expect(head([tool("t1", "Read", { file_path: "a.ts" }), thinking("live", "", true)])).toMatchObject({ label: "Thinking", entryId: "phase-t1" });
  expect(head([narration("n1", "Checking the ledger."), tool("c1", "Read", { file_path: "a.ts" }), thinking("live", "", true)])).toMatchObject({ label: "Checking the ledger", entryId: "phase-n1" });
  expect(head([tool("t1", "Read", { file_path: "a.ts" })])).toMatchObject({ label: "Reading a.ts", entryId: "phase-t1" });
  expect(head([activity("activity-request-3", "Waiting for Claude", "running")])).toMatchObject({ label: "Waiting for Claude", entryId: null });
  expect(head([])).toMatchObject({ label: "Working", entryId: null });
  // A streaming reply below the work speaks for itself.
  expect(head([tool("t1", "Read", { file_path: "a.ts" })], [tool("t1", "Read", { file_path: "a.ts" }), narration("reply", "Done", true)])).toBeNull();
});

it("sums up a finished turn by the files it changed and the last check it ran", () => {
  const edit = tool("e1", "Edit", { file_path: "/repo/a.ts", old_string: "a", new_string: "b" });
  const failedEdit = tool("e2", "Edit", { file_path: "/repo/b.ts", old_string: "a", new_string: "b" }, true, { isError: true });
  const tests = (id: string, command: string, isError = false) => tool(id, "Bash", { command, description: "Run tests" }, true, { isError });
  expect(turnReceipt([edit, failedEdit, tests("t1", "pnpm --filter desktop test", true), tests("t2", "pnpm --filter desktop test")])).toEqual(["1 file changed", "tests passed"]);
  expect(turnReceipt([tests("t1", "npx tsc --noEmit -p .", true)])).toEqual(["typecheck failed"]);
  expect(turnReceipt([tests("t1", "npx vitest run 2>&1 | tail -5")])).toEqual(["tests ran"]);
  expect(turnReceipt([tests("t1", "test -d .codegraph || echo none"), tool("r", "Read", { file_path: "a.ts" })])).toEqual([]);
});
