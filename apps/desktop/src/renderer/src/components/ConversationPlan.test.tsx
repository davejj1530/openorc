import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ThreadSummary } from "@openorc/protocol";
import { ConversationPlan } from "./ConversationPlan";

const fixture = vi.hoisted(() => ({
  implement: vi.fn(),
  plan: { id: "plan", threadId: "thread", runId: "run", revision: 1, text: "Ship it", state: "ready", source: "native", updatedAt: 1 } as const,
}));
vi.mock("../lib/query", () => ({
  useRpcMutation: (method: string) => ({ mutate: method === "threads.implementPlan" ? fixture.implement : vi.fn(), isPending: false, error: null }),
}));
vi.mock("../lib/conversation-plans", () => ({
  useConversationPlans: () => ({ query: { error: null }, runtime: {}, plans: [fixture.plan] }),
}));
const thread: ThreadSummary = {
  id: "thread",
  projectId: "project",
  title: "Plan",
  agent: "claude",
  model: null,
  effort: null,
  fastMode: false,
  mode: "plan",
  permissionMode: "review",
  workspaceMode: "current",
  branch: null,
  worktreePath: null,
  baseSha: null,
  baseBranch: null,
  pinnedAt: null,
  seenAt: null,
  doneAt: null,
  snoozedUntil: null,
  prUrl: null,
  prState: null,
  forkedFromId: null,
  forkedAtRunId: null,
  draft: "",
  importedFrom: null,
  createdAt: 0,
  updatedAt: 0,
  lastActivityAt: 0,
  archivedAt: null,
  activity: "idle",
  unread: false,
  session: { status: "idle", message: null },
  context: null,
  queued: [],
  lastAgentEventAt: null,
  taskCount: 0,
  openTaskCount: 0,
};
const modeSelect = () => screen.getByRole<HTMLSelectElement>("combobox", { name: "Implementation mode" });
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it.each([
  { agent: "claude", offered: ["Review everything", "Accept edits", "Autonomous"], permissionMode: "review" },
  { agent: "opencode", offered: ["Autonomous"], permissionMode: "autonomous" },
] as const)("offers $agent only the modes it can run, starting from the strictest", ({ agent, offered, permissionMode }) => {
  render(<ConversationPlan thread={{ ...thread, agent }} />);
  expect(
    within(modeSelect())
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(offered);
  fireEvent.click(screen.getByRole("button", { name: "Implement this plan" }));
  expect(fixture.implement).toHaveBeenCalledWith({ id: "thread", planId: "plan", permissionMode });
});

it("keeps your choice for when the thread returns to an agent that supports it", () => {
  const { rerender } = render(<ConversationPlan thread={thread} />);
  fireEvent.change(modeSelect(), { target: { value: "trusted" } });
  rerender(<ConversationPlan thread={{ ...thread, agent: "opencode" }} />);
  expect(modeSelect().value).toBe("autonomous");
  rerender(<ConversationPlan thread={thread} />);
  expect(modeSelect().value).toBe("trusted");
});
