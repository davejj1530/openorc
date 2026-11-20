import type { Block } from "@openorc/client";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { openThread } from "../lib/router";
import { WorkTranscript } from "./Transcript";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(async () => null), onReady: vi.fn(), onPush: () => () => {} } }));
vi.mock("../lib/router", async (original) => ({ ...(await original<typeof import("../lib/router")>()), openThread: vi.fn(), openTask: vi.fn() }));
afterEach(cleanup);
// The transcript follows its tail through a ResizeObserver, which jsdom lacks.
Object.assign(globalThis, {
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
});

const prompt: Block = { id: "ask", kind: "message", role: "user", text: "Fix the list", streaming: false };
const reply: Block = { id: "reply", kind: "message", role: "assistant", text: "Done.", streaming: false };
const end: Block = { id: "end", kind: "status", boundary: "turn", durationMs: 42000, outcome: "success", text: "turn finished", tone: "ok" };
const call = (id: string, name: string, input: unknown, output: unknown, extra: Partial<Extract<Block, { kind: "tool" }>> = {}): Block => ({
  id,
  kind: "tool",
  name,
  input,
  output,
  done: true,
  isError: false,
  ...extra,
});

/** The turn with its work open, and the line that reads `name`. */
function turn(...work: Block[]) {
  render(<WorkTranscript runId="run" blocks={[prompt, ...work, reply, end]} />);
  fireEvent.click(document.querySelector<HTMLButtonElement>(".turn-receipt")!);
  return (name: RegExp) => screen.getAllByRole("button", { name }).find((button) => button.classList.contains("work-act-head"))!;
}

const failing = [
  " RUN  v4.1.11 /repo",
  " ✓ src/cart.test.ts (3 tests) 10ms",
  " ❯ src/auth.test.ts (2 tests | 1 failed) 60ms",
  " FAIL  src/auth.test.ts > auth > locks the account after five attempts",
  "AssertionError: expected 423, got 401",
  "",
  "- Expected",
  "+ Received",
  "",
  " ❯ src/auth.test.ts:58:31",
  " ❯ node_modules/vitest/dist/chunk.js:12:3",
  " ❯ node_modules/vitest/dist/runner.js:40:9",
  "⎯⎯⎯⎯[1/1]⎯",
  " Test Files  1 failed | 1 passed (2)",
  "      Tests  1 failed | 4 passed (5)",
  "   Duration  70ms (transform 10ms)",
].join("\n");

it("draws a test run as its files, a failed case with what went wrong and the line it failed on", () => {
  const line = turn(call("t", "Bash", { command: "npx vitest run", description: "Run the tests" }, failing, { isError: true, status: "error" }));
  const row = line(/Run the tests/);
  fireEvent.click(row);
  const piece = row.closest<HTMLElement>(".work-act")!;
  const files = [...piece.querySelectorAll<HTMLElement>(".work-test-file")];
  // Failed files come first.
  expect(files.map((file) => [file.dataset["state"], file.querySelector(".work-test-file-name")?.textContent])).toEqual([
    ["failed", "auth.test.ts"],
    ["passed", "cart.test.ts"],
  ]);
  const failed = within(files[0]!);
  expect(failed.getByText("locks the account after five attempts")).toBeTruthy();
  expect(failed.getByText("AssertionError: expected 423, got 401")).toBeTruthy();
  expect(failed.getByText("src/auth.test.ts:58").closest("a")?.getAttribute("href")).toBe("src/auth.test.ts#L58");
  // Code the project did not write waits behind a count.
  expect(piece.textContent).not.toContain("node_modules/vitest/dist/chunk.js");
  fireEvent.click(failed.getByRole("button", { name: "2 library frames" }));
  expect(piece.textContent).toContain("node_modules/vitest/dist/chunk.js:12");
  // The results are the output read: the screen gives way to them, and the whole output is one press away.
  expect(piece.querySelector(".work-screen")).toBeNull();
  expect(within(piece).getByRole("button", { name: "Whole output" })).toBeTruthy();
});

it("narrows a run's files to one outcome when they came out differently", () => {
  const line = turn(call("t", "Bash", { command: "npx vitest run", description: "Run the tests" }, failing, { isError: true, status: "error" }));
  fireEvent.click(line(/Run the tests/));
  fireEvent.click(screen.getByRole("radio", { name: "Passed" }));
  expect([...document.querySelectorAll(".work-test-file-name")].map((name) => name.textContent)).toEqual(["cart.test.ts"]);
  cleanup();
  // One outcome needs no filter.
  const passing = turn(
    call("t", "Bash", { command: "npx vitest run", description: "Run the tests" }, " RUN  v4.1.11 /repo\n ✓ src/cart.test.ts (3 tests) 10ms\n Test Files  1 passed (1)\n      Tests  3 passed (3)"),
  );
  fireEvent.click(passing(/Run the tests/));
  expect(screen.queryByRole("radiogroup")).toBeNull();
});

it("draws a message to another thread as a line of the step, which opens to what it said and how it landed", () => {
  const read = call("r", "Read", { file_path: "src/a.ts" }, "1\tconst a = 1;");
  const sent = call(
    "s",
    "openorc.thread_send",
    { id: "t1", text: "One question about the server half.\nAnswer when you pause." },
    JSON.stringify({ delivered: true, message: "Delivered to the running turn." }),
  );
  const line = turn(read, sent);
  const row = line(/^Sent message One question about the server half\./);
  // It is a line among the step's lines, not a row of another kind under them.
  expect(row.closest(".work-acts")).toBeTruthy();
  expect(document.querySelector(".work-phase-extras")).toBeNull();
  fireEvent.click(row);
  const piece = row.closest<HTMLElement>(".work-act")!;
  // The message as it was said, then where it landed, in words: nothing of the call's data.
  expect(piece.querySelector(".own-bubble")?.textContent).toContain("Answer when you pause.");
  expect(within(piece).getByText("Delivered to the running turn.")).toBeTruthy();
  expect(piece.textContent).not.toContain('delivered"');
  expect(piece.querySelector(".tool-view-fields")).toBeNull();
});

it("draws a list of threads as thread rows that open their thread, and a thread that was read as its conversation", () => {
  const thread = { id: "t1", title: "Cloud threads", activity: "running", branch: "cloud", current: false, lastReply: "**Half** done.", lastActivityAt: Date.now() - 5 * 60_000 };
  const here = { ...thread, id: "t0", title: "This one", activity: "idle", current: true, lastReply: null };
  const many = Array.from({ length: 5 }, (_, index) => ({ ...thread, id: `more-${index}`, title: `Older ${index}`, activity: "idle" }));
  const listed = call("l", "openorc.thread_list", {}, JSON.stringify([thread, here, ...many]));
  const messages = [
    { role: "assistant", text: "The fix is committed." },
    { role: "system", text: 'Message from the thread "Seats lane" (id 11111111-2222-3333-4444-555555555555):\n\nRebase when ready.' },
    { role: "user", text: "Go ahead." },
  ];
  const read = call("r", "openorc.thread_read", { id: "t1" }, JSON.stringify({ thread, messages }));
  const line = turn(listed, read);

  const list = line(/^Listed threads/);
  expect(list.textContent).toContain("7 threads");
  fireEvent.click(list);
  const rows = [...list.closest(".work-act")!.querySelectorAll<HTMLElement>(".own-row")];
  // The first few show; the rest wait behind a count.
  expect(rows.map((row) => row.querySelector(".own-row-title > span")?.textContent)).toEqual(["Cloud threads", "This one", "Older 0", "Older 1"]);
  expect(rows[0]!.textContent).toContain("cloud");
  expect(rows[0]!.textContent).toContain("5m ago");
  expect(rows[0]!.querySelector(".own-row-last")?.textContent).toBe("Half done.");
  expect(rows[1]!.textContent).toContain("this thread");
  fireEvent.click(screen.getByRole("button", { name: "3 more threads" }));
  expect(list.closest(".work-act")!.querySelectorAll(".own-row")).toHaveLength(7);
  fireEvent.click(rows[0]!);
  expect(openThread).toHaveBeenCalledWith("t1");
  // The thread the call was made from is the one already open: its row is not a way anywhere.
  expect(rows[1]!.tagName).toBe("LI");

  const talk = line(/^Read thread Cloud threads/);
  expect(talk.textContent).toContain("last 3 messages");
  fireEvent.click(talk);
  const piece = talk.closest<HTMLElement>(".work-act")!;
  expect(piece.querySelector(".own-you")?.textContent).toBe("Go ahead.");
  expect(piece.textContent).toContain("The fix is committed.");
  expect(piece.querySelector(".own-from")?.textContent).toContain("Rebase when ready.");
  fireEvent.click(within(piece).getByRole("button", { name: "From Seats lane" }));
  expect(openThread).toHaveBeenCalledWith("11111111-2222-3333-4444-555555555555");
});

it("says what OpenOrc's own tools did, folds one tool called again to the same words, and keeps each call's answer", () => {
  const shot = (id: string) => call(id, "openorc.browser", { action: "screenshot" }, JSON.stringify({ url: "http://localhost/", title: id }));
  const line = turn(call("o", "openorc.browser", { action: "open", url: "http://localhost:4321/" }, "{}"), shot("first"), shot("second"));
  expect(line(/^Opened localhost:4321/)).toBeTruthy();
  const folded = line(/^Took a screenshot/);
  expect(folded.textContent).toContain("2 times");
  fireEvent.click(folded);
  const each = [...folded.closest(".work-act")!.querySelectorAll<HTMLButtonElement>(":scope .work-act .work-act-head")];
  expect(each).toHaveLength(2);
  fireEvent.click(each[0]!);
  expect(each[0]!.closest(".work-act")!.textContent).toContain("first");
});
