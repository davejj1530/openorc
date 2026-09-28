import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentEvent } from "@openorc/protocol";
import { core } from "../lib/rpc";
import { applyFrame, getRun, hydrate, resetTranscripts } from "../lib/transcript";
import { TranscriptContents } from "./Transcript";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onFrame: vi.fn(), onInvalidate: vi.fn(), onReady: vi.fn() } }));
vi.mock("./TaskCard", () => ({ TaskCard: () => null }));
vi.mock("./AgentOrb", () => ({ AgentOrb: () => null }));
afterEach(() => {
  cleanup();
  resetTranscripts();
  vi.clearAllMocks();
});

const events: AgentEvent[] = [
  {
    type: "approval.requested",
    runId: "run",
    ts: 1,
    approvalId: "ask",
    kind: "user_input",
    input: {
      questions: [
        { id: "feel", question: "How does it feel?", options: [{ label: "Better" }] },
        { id: "details", question: "What should stay?", multiSelect: true },
      ],
    },
  },
  { type: "approval.resolved", runId: "run", ts: 2, approvalId: "ask", decision: "allow", answers: { feel: ["Better"], details: ["Spacing", "My custom answer"] } },
];

it.each(["reopened"])("shows submitted choices and custom answers in the %s transcript", async (mode) => {
  if (mode === "live") applyFrame({ runId: "run", seq: 1, events });
  else {
    vi.mocked(core.call).mockResolvedValueOnce({ events, fromTurn: 0, live: false });
    await hydrate("run");
  }
  render(<TranscriptContents runId="run" blocks={getRun("run")!.blocks} />);
  expect(screen.getByText("Better")).toBeTruthy();
  expect(screen.getByText("Spacing")).toBeTruthy();
  expect(screen.getByText("My custom answer")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
});

it("masks secret answers and does not show answers for declined questions", () => {
  const block = {
    id: "secret",
    kind: "approval" as const,
    approvalId: "secret",
    approvalKind: "user_input",
    input: { questions: [{ id: "secret", question: "Secret value?", isSecret: true }] },
    decision: "allow",
    answers: { secret: ["private-value"] },
  };
  const { rerender } = render(<TranscriptContents runId="run" blocks={[block]} />);
  expect(screen.getByText("Answer hidden")).toBeTruthy();
  expect(screen.queryByText("private-value")).toBeNull();
  rerender(<TranscriptContents runId="run" blocks={[{ ...block, decision: "deny" }]} />);
  expect(screen.getByText("declined")).toBeTruthy();
  expect(screen.queryByLabelText("Your answer")).toBeNull();
});
