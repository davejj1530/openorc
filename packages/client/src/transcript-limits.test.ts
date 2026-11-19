import { expect, it } from "vitest";
import type { AgentEvent } from "@openorc/protocol";
import { applyEvents, emptyRun } from "./transcript.js";
import { turnStatus } from "./turn-model.js";

const runId = "hosted:thread";
const limitStep: AgentEvent = { type: "activity.updated", runId, ts: 2, activityId: "limit", label: "Claude AI usage limit reached", status: "error", recovery: { kind: "usage", provider: "claude" } };
const turnEnd = (extra: Partial<Extract<AgentEvent, { type: "turn.completed" }>>): AgentEvent =>
  ({ type: "turn.completed", runId, ts: 3, turnId: "t1", status: "error", durationMs: 400, ...extra }) as AgentEvent;

it("tells a turn stopped at its usage limit once, by the server's line after it: no failed step, and the turn read as ended, not failed", () => {
  const run = emptyRun(runId);
  applyEvents(run, [{ type: "turn.started", runId, ts: 1, turnId: "t1" } as AgentEvent, limitStep, turnEnd({ status: "cancelled", limited: true })]);
  expect(run.blocks.some((block) => block.kind === "activity")).toBe(false);
  const end = run.blocks.find((block) => block.kind === "status" && block.boundary === "turn");
  expect(end).toMatchObject({ outcome: "limited", tone: "muted" });
  expect(turnStatus({ live: false, writing: false, outcome: "limited", startedAt: 1, durationMs: 400 }, 10).kind).toBe("done");
});

it("keeps the failed step and its way to usage for a turn that failed at a limit on a server without the word", () => {
  const run = emptyRun(runId);
  applyEvents(run, [{ type: "turn.started", runId, ts: 1, turnId: "t1" } as AgentEvent, limitStep, turnEnd({})]);
  expect(run.blocks.find((block) => block.kind === "activity")).toMatchObject({ status: "error", recovery: { kind: "usage" } });
  expect(run.blocks.find((block) => block.kind === "status" && block.boundary === "turn")).toMatchObject({ outcome: "error" });
});
