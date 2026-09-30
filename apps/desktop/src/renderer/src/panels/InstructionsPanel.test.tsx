import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InstructionFile } from "@openorc/protocol";
import { InstructionsPanel } from "./InstructionsPanel";

const files: InstructionFile[] = [
  { scope: "project", path: "/repo/AGENTS.md", content: "Use pnpm.\n", version: "v2" },
  { scope: "project", path: "/repo/CLAUDE.md", content: "", version: null },
  { scope: "personal", path: "/home/me/.claude/CLAUDE.md", content: "Be brief.\n", version: "p1" },
];
const mutate = vi.fn();
vi.mock("../lib/query", () => ({
  queryClient: { setQueryData: vi.fn() },
  useRpc: () => ({ data: files, isLoading: false, error: null, refetch: vi.fn() }),
  useRpcMutation: () => ({ mutate, reset: vi.fn(), isPending: false, error: null, variables: undefined }),
}));

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  mutate.mockReset();
});

it("opens AGENTS.md first and saves an edit with the version it started from", () => {
  render(<InstructionsPanel threadId="t1" />);
  expect(screen.getAllByRole("radio").map((option) => option.textContent)).toEqual(["AGENTS.md", "CLAUDE.md", "Personal"]);
  const editor = screen.getByRole("textbox", { name: "AGENTS.md" });
  const save = screen.getByRole("button", { name: "Save" });
  expect((save as HTMLButtonElement).disabled).toBe(true);

  fireEvent.change(editor, { target: { value: "Use pnpm. Run tests first.\n" } });
  fireEvent.keyDown(editor, { key: "s", metaKey: true });
  expect(mutate).toHaveBeenCalledWith({ threadId: "t1", path: "/repo/AGENTS.md", content: "Use pnpm. Run tests first.\n", version: "v2" }, expect.anything());
});

it("keeps a draft per file and names a missing file instead of showing it empty", () => {
  render(<InstructionsPanel threadId="t1" />);
  fireEvent.change(screen.getByRole("textbox", { name: "AGENTS.md" }), { target: { value: "Draft\n" } });
  fireEvent.click(screen.getByRole("radio", { name: "CLAUDE.md" }));
  expect(screen.getByRole("textbox", { name: "CLAUDE.md" }).getAttribute("placeholder")).toBe("No CLAUDE.md yet");
  fireEvent.click(screen.getByRole("radio", { name: "AGENTS.md" }));
  expect((screen.getByRole("textbox", { name: "AGENTS.md" }) as HTMLTextAreaElement).value).toBe("Draft\n");
});

it("asks before saving over a file that changed after editing began", () => {
  localStorage.setItem("openorc.draft.instructions./repo/AGENTS.md", JSON.stringify({ content: "Mine\n", version: "v1" }));
  render(<InstructionsPanel threadId="t1" />);
  expect(screen.getByText("AGENTS.md changed after you started editing.")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);

  fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(mutate).toHaveBeenCalledWith({ threadId: "t1", path: "/repo/AGENTS.md", content: "Mine\n", version: "v2" }, expect.anything());
});
