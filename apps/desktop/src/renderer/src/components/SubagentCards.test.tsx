import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createClientState } from "@openorc/client";
import { SubagentCards } from "./SubagentCards";
const fixture = vi.hoisted(() => ({ exists: true as boolean | undefined }));
vi.mock("../lib/client", () => ({
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
