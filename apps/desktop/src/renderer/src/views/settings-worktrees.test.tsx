import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { WorktreeEntry, WorktreeRemoval } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { WorktreesRow } from "./settings-worktrees";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});

const GB = 1024 ** 3;
const now = Date.now();
const DAY = 86_400_000;

function entry(id: string, title: string, patch: Partial<WorktreeEntry> = {}): WorktreeEntry {
  return {
    owner: { kind: "thread", id },
    title,
    projectId: "p1",
    projectName: "example-project",
    path: `/tmp/example-project/worktrees/${id}`,
    branch: `openorc/${id}`,
    bytes: GB,
    lastActivityAt: now - 60_000,
    archivedAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    parentThreadId: null,
    prState: null,
    blocked: null,
    ...patch,
  };
}

const rows: WorktreeEntry[] = [
  entry("a", "Old footer work", { archivedAt: now - 3 * DAY, lastActivityAt: now - 3 * DAY }),
  entry("b", "Merged rename", { prState: "merged", bytes: GB / 2 }),
  entry("c", "Current work"),
  entry("d", "Busy but resolved", { archivedAt: now - DAY, blocked: "working" }),
  entry("e", "Other project", { projectId: "p2", projectName: "second-project", prState: "closed", bytes: GB / 4 }),
];

function show(removal: WorktreeRemoval) {
  const answers: Record<string, unknown> = { "worktrees.list": { worktrees: rows }, "worktrees.remove": removal };
  vi.mocked(core.call).mockImplementation(async (method: string) => (answers[method] ?? null) as never);
  render(
    <QueryClientProvider client={queryClient}>
      <WorktreesRow />
    </QueryClientProvider>,
  );
}

const box = (title: string) => screen.getByText(title).closest("label")!.querySelector("input") as HTMLInputElement;

it("counts the worktrees and their size, and opens a list that suggests resolved and finished ones", async () => {
  show({ removed: [], failed: [] });
  expect(await screen.findByText("5 worktrees · 3.75 GB")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Clean up…" }));
  await screen.findByText("Old footer work");
  expect(screen.getByText("example-project")).toBeTruthy();
  expect(screen.getByText("second-project")).toBeTruthy();
  expect(box("Old footer work").checked).toBe(true);
  expect(box("Merged rename").checked).toBe(true);
  expect(box("Other project").checked).toBe(true);
  expect(box("Current work").checked).toBe(false);
  expect(box("Busy but resolved")).toMatchObject({ checked: false, disabled: true });
  expect(screen.getByRole("button", { name: "Remove 3 worktrees · 1.75 GB" })).toBeTruthy();
});

it("removes the chosen worktrees and lists any that stayed, with why", async () => {
  show({ removed: [{ kind: "thread", id: "a" }], failed: [{ owner: { kind: "thread", id: "b" }, message: "Git has no user name or email set." }] });
  await screen.findByText("5 worktrees · 3.75 GB");
  fireEvent.click(screen.getByRole("button", { name: "Clean up…" }));
  await screen.findByText("Old footer work");
  fireEvent.click(box("Other project"));
  fireEvent.click(screen.getByRole("button", { name: "Remove 2 worktrees · 1.50 GB" }));
  await waitFor(() =>
    expect(core.call).toHaveBeenCalledWith("worktrees.remove", {
      owners: [
        { kind: "thread", id: "a" },
        { kind: "thread", id: "b" },
      ],
    }),
  );
  expect(await screen.findByText("Merged rename: Git has no user name or email set.")).toBeTruthy();
  expect(screen.getByText("Removed 1 worktree. These stayed:")).toBeTruthy();
});

it("shows nothing while there are no worktrees", async () => {
  vi.mocked(core.call).mockImplementation(async () => ({ worktrees: [] }) as never);
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <WorktreesRow />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("worktrees.list", {}));
  expect(container.textContent).toBe("");
});
