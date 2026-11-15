import type { ThreadSummary } from "@openorc/protocol";
import type { Block, RunTranscript } from "./transcript.js";
import { workParts, workTurns } from "./work-transcript.js";
import { commandLabel } from "./work-chips.js";
import { turnReceipt } from "./work-receipt.js";
import { liveHeadline, workEntries } from "./work-steps.js";
import { threadActivity } from "./thread-row.js";

export interface ThreadHeadline {
  text: string;
  tone: "live" | "attention" | "done" | "muted";
}

type Approval = Extract<Block, { kind: "approval" }>;

function commandWords(command: unknown): string {
  if (Array.isArray(command)) return command.join(" ");
  return typeof command === "string" ? command : "";
}

/** "Needs approval · git push origin main": the command or tool the agent is waiting on. */
function approvalWords(ask: Approval): string {
  if (ask.approvalKind === "user_input") return "Has a question for you";
  const what = commandWords((ask.input as { command?: unknown } | null)?.command) || ask.toolName || "";
  return what ? `Needs approval · ${commandLabel(what)}` : "Needs your approval";
}

/**
 * What a thread's row says about its agent when that beats branch and time: the step it is on, what it is waiting
 * for, or what a finished turn came to. `run` is the thread's live run, whose transcript the app already holds.
 */
export function threadHeadline(thread: Pick<ThreadSummary, "activity" | "unread" | "owner">, run: RunTranscript | undefined): ThreadHeadline | null {
  if (thread.activity === "waiting") {
    const activity = threadActivity(thread);
    if (activity?.tone === "muted") return activity;
    const ask = run?.blocks.findLast((block): block is Approval => block.kind === "approval" && !block.decision);
    return { text: ask ? approvalWords(ask) : "Needs you", tone: "attention" };
  }
  const turn = run ? workTurns(run.blocks).at(-1)?.blocks : undefined;
  if (thread.activity === "running") {
    if (!turn) return { text: "Working", tone: "live" };
    const headline = liveHeadline(workEntries(workParts(turn, true).work), turn);
    return { text: headline?.label ?? "Writing the reply", tone: "live" };
  }
  if (!thread.unread || !turn) return null;
  const receipt = turnReceipt(turn);
  return receipt.length ? { text: ["Done", ...receipt].join(" · "), tone: "done" } : null;
}
