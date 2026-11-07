import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createClientState, type Block } from "@openorc/client";
import { SubagentCards } from "./SubagentCards";
const fixture = vi.hoisted(() => ({ exists: true as boolean | undefined }));
vi.mock("../lib/client", () => ({
  useRpc: () => ({ data: undefined }),
  useRpcs: () => {
    if (fixture.exists === undefined) return [{ data: undefined }];
    return [{ data: fixture.exists ? { id: "child" } : null }];
  },
}));
vi.mock("../lib/router", () => ({ openThread: vi.fn() }));
afterEach(() => cleanup());
it("hides a deleted child even when saved history only contains its final card update", () => {
  const { runs } = createClientState(
    { delivery: "all", setFrameInterest: () => {}, call: vi.fn(), onPush: () => () => {} },
    {
      scheduleFrame: (f) => f(),
      invalidationBatchMs: 0,
      randomId: () => "id",
      savesDefaultPermission: false,
      reportFrameError: (_frame, error) => {
        throw error;
      },
    },
  );
  runs.applyFrame({ runId: "parent", seq: 1, events: [{ type: "subagent.updated", runId: "parent", ts: 1, subagentId: "native", threadId: "child", status: "completed" }] });
  const blocks = runs.get("parent")!.blocks.filter((block) => block.kind === "tool");
  const view = render(<SubagentCards blocks={blocks} />);
  expect(screen.getByRole("button", { name: "Open Subagent" })).toBeTruthy();
  fixture.exists = undefined;
  view.rerender(<SubagentCards blocks={blocks} />);
  expect(screen.getByRole("button", { name: "Open Subagent" })).toBeTruthy();
  fixture.exists = false;
  view.rerender(<SubagentCards blocks={blocks} />);
  expect(screen.queryByRole("button", { name: "Open Subagent" })).toBeNull();
  expect(view.container.childElementCount).toBe(0);
});

it("shows an agent's brief and report as formatted text, the brief folded when long", async () => {
  fixture.exists = true;
  const brief = `Polish the comments.\n\n## Hard rules\n${Array.from({ length: 12 }, (_, i) => `- Rule ${i + 1} with \`code\``).join("\n")}`;
  const block: Block = {
    id: "agent",
    kind: "tool",
    name: "Agent",
    input: {},
    done: true,
    subagent: {
      nativeId: "agent",
      threadId: "child",
      title: "Rebuild comments",
      agentType: "pstack:poteto-agent",
      model: "opus",
      prompt: brief,
      result: "Done. **Three things changed.**",
      status: "completed",
      startedAt: 1,
      endedAt: 2,
    },
  };
  render(<SubagentCards blocks={[block]} />);
  expect(screen.getByText("poteto-agent · Opus")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Details for Rebuild comments" }));
  const heading = await screen.findByRole("heading", { name: "Hard rules" });
  expect(screen.queryByText(/## Hard rules/)).toBeNull();
  expect(within(heading.closest("dd")!).getAllByRole("listitem")).toHaveLength(12);
  expect(screen.getByText("Three things changed.").tagName).not.toBe("P");
  const more = screen.getByRole("button", { name: "Show the whole brief" });
  fireEvent.click(more);
  expect(more.getAttribute("aria-expanded")).toBe("true");
});
