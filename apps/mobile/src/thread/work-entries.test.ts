import { workEntries, type Block, type WorkPhase } from "@openorc/client";
import { expect, it } from "vitest";
import { finishedTurn, runStore } from "./test-fixtures/run-store";
import { keepPhases, phaseDetail } from "./work-entries";

const thought = (id: string, text: string, endedAt: number | null): Block => ({ id, kind: "thinking", text, startedAt: 1, endedAt });
const call = (id: string): Block => ({ id, kind: "tool", name: "commandExecution", input: { command: `cat ${id}.ts` }, done: true, output: "ok" });

it("keeps each finished phase's object while the live phase's reasoning grows, so only the live phase redraws", () => {
  const previous = new Map<string, WorkPhase>();
  const done = [thought("t1", "**Reading the store**\n\nLooking at it.", 2), call("store")];
  const first = keepPhases(workEntries([...done, thought("t2", "**Checking the list**\n\nIt", null)]), previous);
  const second = keepPhases(workEntries([...done, thought("t2", "**Checking the list**\n\nIt keeps rows.", null)]), previous);
  const phases = (entries: typeof first) => entries.flatMap((entry) => (entry.kind === "phase" ? [entry.phase] : []));
  expect(phases(first)).toHaveLength(2);
  expect(phases(second)[0]).toBe(phases(first)[0]);
  expect(phases(second)[1]).not.toBe(phases(first)[1]);
  expect(phases(second)[1]!.detail).toBe("It keeps rows.");
});

it("reads a live reasoning phase's words from the run as they arrive, past the block its row was made from", () => {
  const { frame } = runStore();
  frame(...finishedTurn);
  let run = frame({ type: "turn.started", turnId: "t2" }, { type: "thinking.delta", messageId: "why", text: "**Building the package**\n\nRunning" });
  const block = run.blocks.find((candidate) => candidate.kind === "thinking")!;
  const phase = workEntries([block]).flatMap((entry) => (entry.kind === "phase" ? [entry.phase] : []))[0]!;
  run = frame({ type: "thinking.delta", messageId: "why", text: " the build first." });
  const runs = new Map([["r", run]]);
  expect(phase.detail).toBe("Running");
  expect(phaseDetail(runs, "r", phase)).toBe("Running the build first.");
});
