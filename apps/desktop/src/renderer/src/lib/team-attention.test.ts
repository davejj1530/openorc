import { expect, it } from "vitest";
import type { TeamActorView, TeamExecutionView } from "@openorc/protocol";
import type { Block, RunTranscript } from "./transcript";
import { teamAttention } from "./team-attention";

function actor(id: string, runIds: string[], extra: Partial<TeamActorView> = {}): TeamActorView {
  return {
    id,
    memberKey: id,
    runIds,
    runs: [],
    taskId: id === "lead" ? null : id,
    parentId: id === "lead" ? null : "lead",
    createdAt: 1,
    title: id,
    state: "running",
    settings: { agent: "codex", model: "model", effort: "high", fastMode: false },
    activeRunId: runIds.at(-1) ?? null,
    error: null,
    result: null,
    workspace: null,
    retry: { allowed: true, reason: null },
    ...extra,
  };
}
function execution(actors: TeamActorView[]): TeamExecutionView {
  return {
    id: "execution",
    actors,
    publications: [],
    userDirections: [],
    initialPrompt: { text: "Go", attachments: [], createdAt: 1 },
    state: "active",
    generation: 1,
    createdAt: 1,
    updatedAt: 2,
    activity: "working",
    error: null,
  };
}
function run(blocks: Block[]): RunTranscript {
  return { runId: "run", blocks, blockIndex: new Map(), live: true, hydrated: true, fromTurn: 0, eventCount: blocks.length, turnsCompleted: 0, turnOf: new Map(), pendingApprovals: 1, stderr: [] };
}
const question: Block = { id: "question", kind: "approval", approvalKind: "user_input", approvalId: "question", input: { questions: [{ question: "Which option?" }] } };
it("collects questions and permissions from collapsed nested assignments and deduplicates warm runs", () => {
  const data = execution([actor("lead", ["lead"]), actor("child", ["child"]), actor("nested", ["nested", "nested"], { parentId: "child" })]);
  const runs = new Map([
    ["lead", run([question])],
    ["child", run([{ ...question, decision: "allow" }])],
    ["nested", run([{ ...question, approvalKind: "command" }])],
  ]);
  expect(teamAttention([data], runs).map((item) => item.id)).toEqual(["approval:lead:question", "approval:nested:question"]);
  runs.set("lead", run([{ ...question, decision: "deny" }]));
  runs.set("nested", run([{ ...question, decision: "expired" }]));
  expect(teamAttention([data], runs)).toEqual([]);
});
it("collects actionable recovery and Plan holds even without a transcript", () => {
  const data = execution([actor("lead", []), actor("failed", [], { state: "attention", error: "Failed" }), actor("held", [], { modeHold: "plan" })]);
  expect(teamAttention([data], new Map()).map((item) => item.id)).toEqual(["actor:execution:failed", "actor:execution:held"]);
});
