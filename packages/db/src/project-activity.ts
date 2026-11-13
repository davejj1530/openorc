import { HarnessId, type ProjectActivity, type RpcParams } from "@openorc/protocol";
import { z } from "zod";
import type { Db } from "./database.js";

const Turn = z.object({ ts: z.number(), agent: z.string(), thread: z.string() });

/** The day a time falls in: the last boundary at or before it. */
function dayOf(boundaries: number[], ts: number): number {
  let low = 0;
  let high = boundaries.length - 2;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (boundaries[middle]! <= ts) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * Turns the project's agents finished and steps they took, by day. A subagent's turns are part of its parent's, so
 * only the conversations a person or an agent started count turns; a subagent's steps are its own, never repeated in
 * its parent's events, so every thread counts steps. A forked thread resumes its agent's session and copies neither.
 */
export function projectActivity(db: Db, { id, boundaries }: RpcParams<"projects.activity">): ProjectActivity {
  const days = boundaries.slice(0, -1).map(() => ({ turns: 0, steps: 0, threads: new Set<string>(), agents: new Map<HarnessId, number>() }));
  const start = boundaries[0]!;
  const end = boundaries.at(-1)!;
  const turns = db
    .stmt(
      `
    SELECT e.ts AS ts, r.agent AS agent, r.thread_id AS thread
    FROM threads t
    JOIN runs r ON r.thread_id = t.id
    JOIN events e ON e.run_id = r.id AND e.kind = 'turn.completed'
    WHERE t.project_id = ? AND t.parent_relation IS NOT 'subagent' AND e.ts >= ? AND e.ts < ?
  `,
    )
    .iterate(id, start, end);
  for (const record of turns) {
    const row = Turn.parse(record);
    const day = days[dayOf(boundaries, row.ts)]!;
    day.turns += 1;
    day.threads.add(row.thread);
    const agent = HarnessId.safeParse(row.agent);
    if (agent.success) day.agents.set(agent.data, (day.agents.get(agent.data) ?? 0) + 1);
  }
  // A busy project takes tens of thousands of steps a year; events_steps answers this from the index alone.
  const steps = db
    .stmt(
      `
    SELECT e.ts AS ts
    FROM threads t
    JOIN runs r ON r.thread_id = t.id
    JOIN events e ON e.run_id = r.id AND e.kind = 'tool.completed'
    WHERE t.project_id = ? AND e.ts >= ? AND e.ts < ?
  `,
    )
    .iterate(id, start, end);
  for (const record of steps) {
    const { ts } = record as { ts: number };
    days[dayOf(boundaries, ts)]!.steps += 1;
  }
  return {
    days: days.map((day) => ({
      turns: day.turns,
      steps: day.steps,
      threads: day.threads.size,
      agents: Array.from(day.agents, ([agent, turns]) => ({ agent, turns })).sort((a, b) => b.turns - a.turns),
    })),
  };
}
