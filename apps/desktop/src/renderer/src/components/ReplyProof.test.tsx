import type { Block } from "@openorc/client";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkTranscript } from "./Transcript";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(async () => null), onReady: vi.fn(), onPush: () => () => {} } }));
afterEach(cleanup);
// The transcript follows its tail through a ResizeObserver, which jsdom lacks.
Object.assign(globalThis, {
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
});

const prompt: Block = { id: "ask", kind: "message", role: "user", text: "The list crashes, fix it", streaming: false };
const edit: Block = { id: "edit", kind: "tool", name: "Edit", input: { file_path: "src/Row.tsx", old_string: "rows[0]!", new_string: "rows[0]\n?? first" }, output: "ok", done: true };
const typecheck: Block = { id: "tsc", kind: "tool", name: "Bash", input: { command: "npx tsc --noEmit", description: "Run the typecheck" }, output: "", done: true, isError: false };
const end: Block = { id: "end", kind: "status", boundary: "turn", durationMs: 42000, outcome: "success", text: "turn finished", tone: "ok" };
const said = ["The crash is fixed.", "", "- `src/Row.tsx` guards the first row, as `src/Row.tsx` should.", "", "Typecheck passes and the tests pass."].join("\n");
const reply = (streaming: boolean, text = said): Block => ({ id: "reply", kind: "message", role: "assistant", text, streaming });

const marks = () => [...document.querySelectorAll(".proof-chip, .proof-none")].map((mark) => mark.textContent);

it("ends each sentence of a finished turn's reply with what backs it, once", async () => {
  render(<WorkTranscript runId="run" blocks={[prompt, edit, typecheck, reply(false), end]} />);
  // One file changed, so the sentence that names none and the one that names it call on the same edit: it shows once.
  await waitFor(() => expect(marks()).toEqual(["Row.tsx +2 −1", "Typecheck passed", "No test run this turn"]));
  expect(screen.getByRole("button", { name: "Row.tsx +2 −1" }).closest("p")?.textContent).toContain("The crash is fixed.");
  expect(document.querySelector(".proof-none")?.closest("p")?.textContent).toContain("the tests pass");
});

it("opens the work behind a sentence under it, as its line in the activity, and folds it on a second press", async () => {
  render(<WorkTranscript runId="run" blocks={[prompt, edit, typecheck, reply(false), end]} />);
  const chip = await screen.findByRole("button", { name: "Row.tsx +2 −1" });
  const body = chip.closest("p")!.nextElementSibling as HTMLElement;
  expect(body.className).toContain("proof-body");
  expect(body.hidden).toBe(true);
  fireEvent.click(chip);
  expect(chip.getAttribute("aria-expanded")).toBe("true");
  expect(body.hidden).toBe(false);
  expect([...body.querySelectorAll(".work-edit-line")].map((line) => line.textContent)).toEqual(["−rows[0]!", "+rows[0]", "+?? first"]);
  fireEvent.click(chip);
  expect(body.hidden).toBe(true);
});

it("marks nothing while the turn runs or its reply is still being written", async () => {
  const { rerender } = render(<WorkTranscript runId="run" blocks={[prompt, edit, typecheck, reply(true)]} live />);
  // Words being written each stand in an element of their own.
  await waitFor(() => expect(document.querySelector(".journal-response")?.textContent).toContain("The crash is fixed."));
  expect(marks()).toEqual([]);
  rerender(<WorkTranscript runId="run" blocks={[prompt, edit, typecheck, reply(false), end]} />);
  await waitFor(() => expect(marks()).toHaveLength(3));
});

it("leaves a reply alone in a turn that did nothing its sentences call on", async () => {
  render(<WorkTranscript runId="run" blocks={[prompt, reply(false, "The tests pass on main, as they did yesterday."), end]} />);
  await screen.findByText(/as they did yesterday/);
  expect(marks()).toEqual([]);
});
