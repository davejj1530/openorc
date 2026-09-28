import type { TeamActorView, TeamExecutionView } from "@openorc/protocol";
import type { Block, RunTranscript } from "./transcript";

type Approval = Extract<Block, { kind: "approval" }>;
export type TeamAttentionItem = { id: string; execution: TeamExecutionView } & (
  { kind: "approval"; actor: TeamActorView; runId: string; block: Approval } | { kind: "actor"; actor: TeamActorView } | { kind: "publication"; receipt: TeamExecutionView["publications"][number] }
);

/** Include nested assignments as well as roster members, independently of disclosure state. */
export function teamAttention(executions: TeamExecutionView[], runs: ReadonlyMap<string, RunTranscript>): TeamAttentionItem[] {
  const items: TeamAttentionItem[] = [];
  const seen = new Set<string>();
  for (const execution of executions) {
    for (const actor of execution.actors) {
      for (const runId of actor.runIds) {
        for (const block of runs.get(runId)?.blocks ?? []) {
          if (block.kind !== "approval" || block.decision) continue;
          const id = `approval:${runId}:${block.approvalId}`;
          if (seen.has(id)) continue;
          seen.add(id);
          items.push({ kind: "approval", id, execution, actor, runId, block });
        }
      }
      if (actor.state === "attention" || actor.workspace?.error || actor.modeHold) items.push({ kind: "actor", id: `actor:${execution.id}:${actor.id}`, execution, actor });
    }
    for (const receipt of execution.publications) {
      if (receipt.state !== "applied") items.push({ kind: "publication", id: `publication:${receipt.id}`, execution, receipt });
    }
  }
  return items;
}

/** Keep the original request readable in history without duplicating answer controls. */
export function teamRequestSummary(block: Approval): string {
  const input = block.input && typeof block.input === "object" ? (block.input as Record<string, unknown>) : {};
  if (block.approvalKind === "user_input" && Array.isArray(input.questions)) {
    const questions = input.questions.flatMap((question) => {
      if (!question || typeof question !== "object") return [];
      const text = question.question ?? question.header;
      return typeof text === "string" && text.trim() ? [text] : [];
    });
    if (questions.length) return questions.join("\n");
  }
  if (block.reason !== null && block.reason !== undefined) return block.reason;
  if (block.toolName) return `Approval requested for ${block.toolName}`;
  if (block.approvalKind === "user_input") return "Question pending";
  return "Approval pending";
}
