import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { FolderPath, type CodeExplainResult, type FileScope } from "@openorc/protocol";

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../../lib/rpc", () => ({ core: { call, onPush: () => () => {}, onReady: () => () => {} } }));
vi.mock("../../components/code-editor", () => ({
  CodeExcerpt: ({ start, end }: { start: number; end: number }) => <pre data-testid="excerpt">{`${start}-${end}`}</pre>,
}));
vi.mock("../../components/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../components/ui")>()),
  Tooltip: ({ children }: { children: ReactNode }) => children,
}));

import { ExplainView } from "./ExplainView";
import { useExplanations } from "../../lib/code-explanations";
import { useLayout } from "../../lib/layout";
import { useRouter } from "../../lib/router";

const scope: FileScope = { kind: "thread", id: "thread" };
const path = FolderPath.parse("src/cart.ts");
const text = "import { sum } from './sum';\n\nexport function cartTotal() {\n  return sum();\n}\n";
const model = { provider: "claude" as const, label: "Claude Haiku 4.5" };
const english: CodeExplainResult = {
  kind: "explained",
  explanation: {
    view: "english",
    notes: [
      { lines: { start: 1, end: 1 }, text: "Borrows `sum` from another file." },
      { lines: { start: 3, end: 3 }, text: "Starts a recipe called `cartTotal`." },
      { lines: { start: 4, end: 4 }, text: "Adds up the cart and hands back the total." },
    ],
  },
  model,
  createdAt: 1,
};
const walkthrough: CodeExplainResult = {
  kind: "explained",
  model,
  createdAt: 1,
  explanation: {
    view: "walkthrough",
    overview: "Totals a cart.",
    blocks: [
      {
        lines: { start: 3, end: 5 },
        title: "Cart total",
        explanation: "Sums the items.",
        steps: [
          { lines: { start: 3, end: 3 }, text: "Starts the recipe." },
          { lines: { start: 4, end: 4 }, text: "Hands back the sum." },
        ],
        symbols: ["cartTotal"],
        usedBy: [{ path: FolderPath.parse("src/checkout.ts"), line: 4, text: "cartTotal()" }],
      },
    ],
  },
};

let answer: (result: CodeExplainResult) => void;
beforeEach(() => {
  useExplanations.setState({ entries: {} });
  call.mockReset().mockImplementation(() => new Promise((resolve) => (answer = resolve)));
});
afterEach(cleanup);

const view = (props: Partial<Parameters<typeof ExplainView>[0]> = {}) => <ExplainView view="english" scope={scope} path={path} text={text} onShowLines={vi.fn()} {...props} />;

it("asks once when the view opens, says it is working, then shows the explanation and who wrote it", async () => {
  const { rerender } = render(view());
  expect(screen.getByRole("status").textContent).toContain("Explaining cart.ts…");
  rerender(view());
  expect(call).toHaveBeenCalledTimes(1);
  expect(call).toHaveBeenCalledWith("code.explain", { scope, path, view: "english", text });
  await act(async () => answer(english));
  expect(screen.getByText("Explained by Claude Haiku 4.5")).toBeTruthy();
});

it("reads the file line by line: each line's code, then what it does in plain words", async () => {
  render(view());
  await act(async () => answer(english));
  const notes = [...document.querySelectorAll(".explain-note")].map((note) => [note.querySelector("[data-testid=excerpt]")?.textContent, note.querySelector(".explain-note-text")?.textContent]);
  expect(notes).toEqual([
    ["1-1", "Borrows sum from another file."],
    ["3-3", "Starts a recipe called cartTotal."],
    ["4-5", "Adds up the cart and hands back the total."],
  ]);
  expect(screen.getByText("cartTotal").tagName).toBe("CODE");
});

it("keeps an explanation through edits, says the file changed, and asks again only when told to", async () => {
  const { rerender } = render(view());
  await act(async () => answer(english));
  rerender(view({ text: `${text}// more\n` }));
  expect(screen.getByText("The file changed since it was explained.")).toBeTruthy();
  expect(call).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Explain again" }));
  expect(call).toHaveBeenLastCalledWith("code.explain", { scope, path, view: "english", text: `${text}// more\n`, refresh: true });
  expect(screen.getByText("Explaining again…")).toBeTruthy();
  expect(screen.getByText("cartTotal")).toBeTruthy();
});

it("sends the reader to Settings when that is where the fix is, and offers another try", async () => {
  render(view());
  await act(async () => answer({ kind: "unavailable", reason: "Text generation is off. Turn it on in Settings.", settings: true }));
  expect(screen.getByText("Text generation is off. Turn it on in Settings.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
  expect(useRouter.getState().route).toEqual({ view: "settings", section: "memory" });
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(call).toHaveBeenCalledTimes(2);
});

it("offers no retry for a file that can't be explained, and doesn't ask about one too large to send", async () => {
  render(view());
  await act(async () => answer({ kind: "unavailable", reason: "This file is empty.", settings: false }));
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  cleanup();
  render(view({ text: "x".repeat(160_001), path: FolderPath.parse("big.ts") }));
  expect(screen.getByText("This file is too large to explain.")).toBeTruthy();
  expect(call).toHaveBeenCalledTimes(1);
});

it("asks again about a file that was empty once it has text, and not before", async () => {
  const { rerender } = render(view({ text: "  \n" }));
  await act(async () => answer({ kind: "unavailable", reason: "This file is empty.", settings: false }));
  rerender(view({ text: "  \n" }));
  expect(call).toHaveBeenCalledTimes(1);
  rerender(view());
  expect(call).toHaveBeenCalledTimes(2);
  expect(call).toHaveBeenLastCalledWith("code.explain", { scope, path, view: "english", text });
});

it("frames each block of the walkthrough with its lines explained a step at a time, and the files that use it", async () => {
  const onShowLines = vi.fn();
  render(view({ view: "walkthrough", onShowLines }));
  await act(async () => answer(walkthrough));
  const block = screen.getByRole("region", { name: "Cart total" });
  expect(within(block).getByText("Sums the items.")).toBeTruthy();
  expect([...block.querySelectorAll(".explain-note")].map((note) => [note.querySelector("[data-testid=excerpt]")?.textContent, note.querySelector(".explain-note-text")?.textContent])).toEqual([
    ["3-3", "Starts the recipe."],
    ["4-5", "Hands back the sum."],
  ]);
  expect(screen.getAllByTestId("excerpt").map((excerpt) => excerpt.textContent)).toEqual(["1-1", "3-3", "4-5"]);
  fireEvent.click(within(block).getByRole("button", { name: "Lines 3–5" }));
  expect(onShowLines).toHaveBeenCalledWith({ start: 3, end: 5 });
  const open = vi.spyOn(useLayout.getState(), "openFile");
  fireEvent.click(within(within(block).getByRole("group", { name: "Used by" })).getByRole("button", { name: "src/checkout.ts:4" }));
  await waitFor(() => expect(open).toHaveBeenCalledWith({ path: "src/checkout.ts", scope, line: 4 }));
});
