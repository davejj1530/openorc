import { describe, expect, it } from "vitest";
import { toolDigest, type AgentEvent } from "@openorc/protocol";
import calls from "./test-fixtures/work-calls.json";
import { applyEvents, emptyRun, type Block } from "./transcript.js";
import { workObjects, type GitObject, type WorkObject } from "./work-objects.js";
import { objectOutcome, objectsTitle, phaseOutcome } from "./work-outcomes.js";
import { receiptItems } from "./work-receipt.js";

/** Real calls recorded from Claude, Codex and OpenCode, replayed into blocks the way a transcript reads them. */
function replay(...labels: string[]): Block[] {
  const run = emptyRun("r");
  for (const label of labels) {
    const entry = calls.find((call) => call.label === label || call.label.startsWith(label));
    if (!entry) throw new Error(`No recorded call "${label}"`);
    applyEvents(run, entry.events.map((event) => ({ ...event, runId: "r" })) as AgentEvent[]);
  }
  return run.blocks;
}

function only<K extends WorkObject["kind"]>(blocks: Block[], kind: K): Extract<WorkObject, { kind: K }> {
  const objects = workObjects(blocks);
  expect(objects.map((object) => object.kind)).toEqual([kind]);
  return objects[0] as Extract<WorkObject, { kind: K }>;
}

/** The same call after a transcript page left its output out and kept the core's digest. */
function paged(blocks: Block[]): Block[] {
  return blocks.map((block) => (block.kind === "tool" && block.done ? { ...block, output: undefined, outputOmitted: true, digest: toolDigest(block.output) ?? undefined } : block));
}

describe("git", () => {
  it("reads Claude's commit and push in one call as the branch it moved", () => {
    const git = only(replay("git add, commit -q and push in one call"), "git");
    expect(git.push).toMatchObject({ state: "done", remote: "origin", ref: { from: "4672226", to: "e977884", source: "main", target: "main", created: false } });
    expect(git.branch).toBe("main");
    expect(git.tip).toBe("e977884");
    expect(objectOutcome(git)).toEqual({ text: "Pushed to origin", failed: false });
    expect(objectsTitle([git])).toBe("Pushed main");
  });

  it("reads Codex's commit and new branch from what git printed", () => {
    const git = only(replay("git add, commit and push new branch (remote"), "git");
    expect(git.commits).toEqual([{ sha: "06593a8", subject: "Diagnose bridge benchmark frame timing in private CI", at: expect.any(Number) }]);
    expect(git.push?.ref).toMatchObject({ created: true, source: "diagnose/bridge-frames" });
    expect(git.branch).toBe("diagnose/bridge-frames");
    expect(git.tip).toBe("06593a8");
    expect(objectOutcome(git)?.text).toBe("Published to origin");
  });

  it("shows a push still going while Codex streams it", () => {
    const git = only(replay("live: git add, commit and push new branch"), "git");
    expect(git.state).toBe("running");
    expect(git.push?.state).toBe("running");
    expect(git.commits.map((commit) => commit.sha)).toEqual(["06593a8"]);
    expect(objectOutcome(git)?.text).toBe("Pushing to origin");
  });

  it("fails a push the remote refused even when the call exited 0", () => {
    const git = only(replay("git push rejected"), "git");
    expect(git.push?.state).toBe("failed");
    expect(git.state).toBe("failed");
    expect(objectOutcome(git)).toEqual({ text: "Push rejected", failed: true });
  });

  it("fails a commit that git refused", () => {
    const blocks = replay("git commit failed: pathspec");
    const git = only(blocks, "git");
    expect(git.state).toBe("failed");
    expect(objectOutcome(git)?.failed).toBe(true);
  });

  it("names the pull request a phase opened, and counts it in the receipt", () => {
    const blocks: Block[] = [
      {
        id: "pr",
        kind: "tool",
        name: "Bash",
        input: { command: 'gh pr create --base main --title "Hand a running thread to the cloud" --body "x"', description: "Open the pull request" },
        output: "https://github.com/davejj1530/openorc/pull/218\n",
        done: true,
        isError: false,
        status: "success",
      },
    ];
    const git = only(blocks, "git") as GitObject;
    expect(git.pullRequest).toEqual({ state: "done", number: 218, url: "https://github.com/davejj1530/openorc/pull/218", title: "Hand a running thread to the cloud", base: "main" });
    expect(objectsTitle([git])).toBe("Opened pull request #218");
    expect(receiptItems(blocks, 1, false)).toContainEqual({ kind: "git", label: "#218 open" });
  });

  it("leaves status and history as commands when nothing is published", () => {
    expect(workObjects(replay("git status --short, rev-parse and log")).map((object) => object.kind)).toEqual(["command"]);
  });

  it("draws a look at the branch as part of the branch a step publishes", () => {
    const look: Block = { id: "look", kind: "tool", name: "Bash", input: { command: "git status --short && git log --oneline -3" }, output: " M a.ts", done: true, isError: false };
    const objects = workObjects([look, ...replay("git add, commit and push new branch (remote")]);
    expect(objects.map((object) => object.kind)).toEqual(["git"]);
    expect(objects[0]!.blocks.map((block) => block.id)[0]).toBe("look");
  });
});

describe("tests", () => {
  it("counts a passing Claude vitest run", () => {
    const tests = only(replay("vitest run passing (tail)"), "tests");
    expect(tests.state).toBe("done");
    expect(tests.run?.failed).toBe(0);
    expect(tests.run?.passed).toBeGreaterThan(0);
    expect(objectOutcome(tests)).toEqual({ text: `${tests.run!.passed} passed`, failed: false });
  });

  it("names the failing case and its message in a Codex vitest run", () => {
    const tests = only(replay("vitest run failing with assertion (pnpm exec)"), "tests");
    expect(tests.state).toBe("failed");
    expect(tests.run?.failed).toBeGreaterThan(0);
    expect(tests.run?.failures[0]?.name).toBeTruthy();
    expect(tests.run?.failures[0]?.message).toBeTruthy();
    expect(objectOutcome(tests)).toEqual({ text: `${tests.run!.failed} failed`, failed: true });
  });

  it("still reads the counts once a page left the output out", () => {
    const blocks = replay("vitest run failing with assertion (pnpm exec)");
    const live = only(blocks, "tests");
    const later = only(paged(blocks), "tests");
    expect(later.run).toEqual(live.run);
  });

  it("knows how many cases a rerun expects from the run before it", () => {
    const blocks = replay("vitest run failing with assertion (pnpm exec)", "vitest run passing (same command");
    const [failing, passing] = workObjects(blocks);
    expect(failing?.kind).toBe("tests");
    expect(passing?.kind === "tests" && passing.expected).toBe(failing?.kind === "tests" && failing.run ? failing.run.passed + failing.run.failed + failing.run.skipped : null);
  });

  it("drops a failure from the folded line once a later run of the same command passed", () => {
    const blocks = replay("vitest run failing with assertion (pnpm exec)", "vitest run passing (same command");
    expect(phaseOutcome(workObjects(blocks))?.failed).toBe(false);
  });

  it("reads Claude's pytest, cargo and go runs", () => {
    for (const label of ["pytest runs passing and failing", "cargo test (sample project)", "go test -v failing"]) {
      const objects = workObjects(replay(label));
      expect(
        objects.some((object) => object.kind === "tests" && object.run !== null),
        label,
      ).toBe(true);
    }
  });
});

describe("edits", () => {
  it("shows the lines a Claude Edit replaced", () => {
    const edit = only(replay("Edit"), "edit");
    expect(edit.created).toBe(false);
    expect(edit.lines.some((line) => line.sign === "+")).toBe(true);
    expect(edit.lines.every((line) => line.text.trim() === line.text && line.text.length)).toBe(true);
  });

  it("says a Write made a new file, and an overwrite did not", () => {
    expect(only(replay("Write new file"), "edit").created).toBe(true);
    expect(only(replay("Write overwrite"), "edit").created).toBe(false);
  });

  it("reads Codex's added file and OpenCode's replacement", () => {
    expect(only(replay("apply_patch add file"), "edit").created).toBe(true);
    const opencode = only(replay("edit replacement"), "edit");
    expect(opencode.lines.length).toBeGreaterThan(0);
  });

  it("marks a failed edit", () => {
    expect(only(replay("Edit failed: string not found"), "edit").state).toBe("failed");
  });
});

describe("search", () => {
  it("lists a one-file Claude Grep's matches without its context lines", () => {
    const search = only(replay("Grep content mode with -n and context"), "search");
    expect(search.hits[0]).toMatchObject({ line: 344, text: "export const settings = {" });
    expect(search.hits.every((hit) => hit.path.endsWith("memories.ts"))).toBe(true);
  });

  it("counts the files a Grep listed", () => {
    const search = only(replay("Grep files_with_matches mode"), "search");
    expect(search.matches).toBe(14);
    expect(search.hits[0]?.line).toBeNull();
  });

  it("reads rg hits as file and line", () => {
    const search = only(replay("rg -n via Bash"), "search");
    expect(search.hits[0]).toMatchObject({ line: 457 });
    expect(search.matches).toBe(3);
  });
});

describe("web", () => {
  it("lists a web search's results", () => {
    const web = only(replay("WebSearch"), "web");
    expect(web.links.length).toBeGreaterThan(0);
    expect(web.links[0]?.url).toMatch(/^https:/);
  });

  it("quotes the start of a fetched page", () => {
    const fetch = only(replay("WebFetch"), "fetch");
    expect(fetch.url).toMatch(/^https:/);
    expect(fetch.excerpt).toBeTruthy();
  });
});

describe("reads", () => {
  it("draws reads in a row as one object", () => {
    const objects = workObjects(replay("Read text file", "sed -n via Bash"));
    expect(objects.map((object) => object.kind)).toEqual(["read"]);
    expect(objects[0]?.kind === "read" && objects[0].rows.length).toBe(2);
  });
});

describe("a turn that ended", () => {
  it("stops a call that never finished instead of spinning", () => {
    const objects = workObjects(replay("live: pnpm test across packages"), undefined, false);
    expect(objects.every((object) => object.state !== "running")).toBe(true);
  });
});

describe("review findings", () => {
  const call = (id: string, input: unknown, output: unknown, extra: Partial<Extract<Block, { kind: "tool" }>> = {}): Block => ({
    id,
    kind: "tool",
    name: "Bash",
    input,
    output,
    done: true,
    isError: false,
    ...extra,
  });

  it("does not count a run the turn's end cut short as passing", () => {
    const blocks = replay("live: pnpm test streaming, never completed");
    const [tests] = workObjects(blocks, blocks, false);
    expect(tests?.state).toBe("stopped");
    expect(tests && objectOutcome(tests)?.text).toBe("Tests stopped");
    expect(
      receiptItems(blocks, 1, false)
        .map((item) => item.label)
        .join(),
    ).not.toMatch(/passed/);
  });

  it("does not draw a push the turn's end cut short as finished", () => {
    const blocks = replay("live: git add, commit and push new branch");
    const git = workObjects(blocks, blocks, false)[0] as GitObject;
    expect(git.push).toMatchObject({ state: "stopped", progress: null });
    expect(objectsTitle([git])).toBe("Tried to push diagnose/bridge-frames");
  });

  it("keeps a good commit green when a look at the branch failed", () => {
    const git = workObjects(replay("git log failed: branch has no commits", "git commit with summary (worktree)"))[0];
    expect(git?.kind).toBe("git");
    expect(git?.state).toBe("done");
  });

  it("draws the branch after the edits that led to its commit", () => {
    const edit: Block = { id: "e", kind: "tool", name: "Edit", input: { file_path: "a.ts", old_string: "a", new_string: "b" }, output: "ok", done: true };
    const blocks = [call("s", { command: "git status --short" }, " M a.ts"), edit, ...replay("git commit with summary (worktree)")];
    expect(workObjects(blocks).map((object) => object.kind)).toEqual(["edit", "git"]);
  });

  it("keeps a call's id when its command arrives after it started", () => {
    const commit = replay("git commit with summary (worktree)")[0] as Extract<Block, { kind: "tool" }>;
    const before = workObjects([{ ...commit, input: {}, done: false, output: undefined }])[0]!.id;
    expect(workObjects([commit])[0]!.id).toBe(before);
  });

  it("says a pull request that already existed was not opened", () => {
    const blocks = [
      call("pr", { command: 'gh pr create --title "x"' }, 'a pull request for branch "feat" into branch "main" already exists:\nhttps://github.com/o/r/pull/218', { isError: true, status: "error" }),
    ];
    expect(objectsTitle(workObjects(blocks))).toBe("Tried to open a pull request");
    expect(receiptItems(blocks, 1, false)).not.toContainEqual(expect.objectContaining({ label: "#218 open" }));
  });

  it("reads hits past a line it cannot read, a file without an extension, and a dated file name", () => {
    const listed = call("g", { command: 'rg -l "x" .' }, "Makefile\nsrc/2024-01-report.ts\nShell cwd was reset to /x");
    const search = workObjects([listed])[0];
    expect(search?.kind === "search" && search.hits.map((hit) => hit.path)).toEqual(["Makefile", "src/2024-01-report.ts"]);
    const dated = workObjects([call("d", { command: 'rg -n "foo" src' }, "src/2024-01-report.ts:12:foo")])[0];
    expect(dated?.kind === "search" && dated.hits[0]).toMatchObject({ path: "src/2024-01-report.ts", line: 12 });
  });

  it("opens a hit where the search ran, after the command moved into a folder", () => {
    const moved = call("m", { command: 'cd /repo/packages/client/src && rg -n "^export" tool-view.ts shell.ts' }, "tool-view.ts:152:export function toolInputView(");
    expect(only([moved], "search").hits[0]).toMatchObject({ path: "/repo/packages/client/src/tool-view.ts", line: 152 });
    const codex = call("c", { command: ["/bin/zsh", "-lc", "cd apps && rg -n useTheme"], cwd: "/repo" }, "desktop/src/a.ts:3:useTheme()");
    expect(only([codex], "search").hits[0]?.path).toBe("/repo/apps/desktop/src/a.ts");
  });

  it("counts no matches and OpenCode's count", () => {
    const none = only(replay("rg no matches (exit 1 marks error)"), "search");
    expect(none.matches).toBe(0);
    expect(only(replay("search (grep) with match count only"), "search").matches).toBe(9);
  });

  it("names the file a one-file shell search looked in", () => {
    expect(only(replay("rg -n via Bash"), "search").hits[0]?.path).toMatch(/Composer\.tsx$/);
  });

  it("gives a call that ran several searches no hits rather than the same ones twice", () => {
    const searches = workObjects(replay("grep via shell")).filter((object) => object.kind === "search");
    expect(searches.length).toBeGreaterThan(1);
    expect(searches.every((search) => search.kind === "search" && !search.hits.length)).toBe(true);
  });

  it("shows the lines of a file Codex created and counts them", () => {
    const edit = only(replay("apply_patch add file"), "edit");
    expect(edit.lines.length).toBeGreaterThan(0);
    expect(edit.chip.added).toBeGreaterThan(0);
  });

  it("reads a freeform apply_patch per file", () => {
    const patch: Block = { id: "p", kind: "tool", name: "apply_patch", input: { patch: "*** Begin Patch\n*** Add File: src/new.ts\n+export const a = 1;\n*** End Patch" }, output: "Done", done: true };
    const edit = only([patch], "edit");
    expect(edit).toMatchObject({ created: true, chip: { path: "src/new.ts", added: 1 } });
    expect(edit.lines).toEqual([{ sign: "+", text: "export const a = 1;" }]);
  });

  it("counts OpenCode's replacement", () => {
    const edit = only(replay("edit replacement"), "edit");
    expect((edit.chip.added ?? 0) + (edit.chip.removed ?? 0)).toBeGreaterThan(0);
    expect(objectOutcome(edit)?.text).not.toBe("+0");
  });

  it("says a quiet go run passed without claiming zero", () => {
    const tests = only([call("go", { command: "go test ./..." }, "ok  \texample.com/a\t0.012s\nok  \texample.com/b\t0.020s\n")], "tests");
    expect(objectOutcome(tests)?.text).toBe("Tests passed");
  });

  it("fails a refused push whose To line was cut", () => {
    const git = only([call("p", { command: "git push origin main 2>&1 | tail -2" }, " ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs")], "git");
    expect(git.push?.state).toBe("failed");
  });

  it("reads the remote past a push option", () => {
    expect(only([call("p", { command: "git push -o ci.skip origin main" }, "To x\n   a1b2c3d..e4f5a6b  main -> main")], "git").push?.remote).toBe("origin");
  });

  it("keeps a removed SQL comment line", () => {
    const edit: Block = { id: "e", kind: "tool", name: "Edit", input: { file_path: "q.sql", old_string: "-- old note\nselect 1;", new_string: "select 1;" }, output: "ok", done: true };
    expect(only([edit], "edit").lines).toEqual([{ sign: "-", text: "-- old note" }]);
  });
});
