import type { AgentEvent } from "@openorc/protocol";
import { expect, it } from "vitest";
import { applyEvents, emptyRun } from "./transcript.js";

const ask = (approvalId: string, durable?: boolean): AgentEvent => ({
  type: "approval.requested",
  runId: "run",
  ts: 1,
  approvalId,
  kind: "command",
  toolName: "Bash",
  input: { command: "pnpm build" },
  ...(durable ? { durable } : {}),
});
const turnEnds: AgentEvent = { type: "turn.completed", runId: "run", ts: 2, turnId: "t1", status: "success", durationMs: 1 };
const sessionEnds: AgentEvent = { type: "session.completed", runId: "run", ts: 3, status: "success", durationMs: 1 };
const decisionOf = (run: ReturnType<typeof emptyRun>, approvalId: string) => run.blocks.find((block) => block.kind === "approval" && block.approvalId === approvalId);

it("keeps a durable ask open when its turn and its process end, and expires any other", () => {
  const run = emptyRun("run");
  applyEvents(run, [ask("parked", true), ask("local"), turnEnds, sessionEnds]);
  expect(decisionOf(run, "parked")).toMatchObject({ kind: "approval", durable: true });
  expect(decisionOf(run, "parked")).not.toHaveProperty("decision");
  expect(decisionOf(run, "local")).toMatchObject({ decision: "expired" });
  expect(run.pendingApprovals).toBe(1);
});

it("closes a durable ask once it is answered", () => {
  const run = emptyRun("run");
  applyEvents(run, [ask("parked", true), turnEnds, { type: "approval.resolved", runId: "run", ts: 4, approvalId: "parked", decision: "allow" }]);
  expect(decisionOf(run, "parked")).toMatchObject({ decision: "allow" });
  expect(run.pendingApprovals).toBe(0);
});

it("ends a turn parked on its ask quietly, keeps the ask open, and gives the turn its answer starts a key of its own", () => {
  const run = emptyRun("run");
  const parked: AgentEvent = { type: "turn.completed", runId: "run", ts: 2, turnId: "asker", status: "cancelled", parked: true, durationMs: 300_000 };
  const answer: AgentEvent = { type: "approval.resolved", runId: "run", ts: 3, approvalId: "parked", decision: "allow" };
  const reply: AgentEvent = { type: "message.completed", runId: "run", ts: 4, messageId: "reply", role: "assistant", text: "banner" };
  applyEvents(run, [ask("parked", true), parked]);
  expect(decisionOf(run, "parked")).not.toHaveProperty("decision");
  expect(run.pendingApprovals).toBe(1);
  expect(run.blocks.find((block) => block.id === "turn-asker")).toMatchObject({ kind: "status", boundary: "turn", outcome: "parked", tone: "muted" });
  applyEvents(run, [answer, reply]);
  const keyOf = (id: string) => run.blocks.find((block) => block.id === id)?.turnKey;
  expect(keyOf("reply")).not.toBe(keyOf("approval-parked"));
});
