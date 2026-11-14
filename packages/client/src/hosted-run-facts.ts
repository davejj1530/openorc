import { hostedThreadOf, type AgentEvent } from "@openorc/protocol";
import type { RunTranscript } from "./transcript.js";

/** Context is a reported snapshot, never an estimate from cumulative token usage. */
export function recordHostedContext(run: RunTranscript, event: Extract<AgentEvent, { type: "context.updated" | "usage.updated" }>) {
  if (!hostedThreadOf(run.runId)) return;
  const context = event.type === "context.updated" ? event : event.usage;
  if (context.contextTokens === undefined) return;
  run.context = { used: context.contextTokens, window: context.contextWindow ?? null };
}
