import type { ThreadSummary } from "@openorc/protocol";
import type { Block, RunTranscript } from "./transcript.js";
import { workParts, workTurns } from "./work-transcript.js";
import { commandLabel } from "./work-chips.js";
import { turnReceipt } from "./work-receipt.js";
import { liveHeadline, workEntries } from "./work-steps.js";
import { cloudStartFailure, cloudStartSteps, threadMoveCard } from "./cloud-start.js";

export interface ThreadHeadline {
  text: string;
  tone: "live" | "attention" | "done";
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

/** What a row reads of a thread in the cloud: how it starts there, and how it moves. Absent for rows from before. */
type CloudRow = Partial<Pick<ThreadSummary, "agent" | "owner" | "queued" | "cloud" | "hasStarted" | "moving" | "moveRefused" | "lastActivityAt">>;

/**
 * Before its agent first runs, a cloud thread is being set up: waking the cloud brain, starting its sandbox, sending
 * the code. A move between this Mac and the cloud has steps of its own. Null when neither is under way.
 */
function cloudHeadline(thread: CloudRow): ThreadHeadline | null {
  const { moving, moveRefused, lastActivityAt } = thread;
  if (moving || moveRefused) {
    const card = threadMoveCard({ moving, moveRefused, lastActivityAt: lastActivityAt ?? 0, owner: thread.owner, cloud: thread.cloud });
    if (card?.kind === "refused") return { text: card.title, tone: "attention" };
    const step = card?.steps.find((each) => each.state === "running");
    if (step) return { text: step.label, tone: "live" };
  }
  const { cloud, agent, queued } = thread;
  if (!cloud || !agent || thread.hasStarted || !queued?.length) return null;
  const starting = { cloud, agent, queued, owner: thread.owner };
  if (cloudStartFailure(starting)) return { text: "Didn't start in the cloud", tone: "attention" };
  const step = cloudStartSteps(starting).find((each) => each.state === "running");
  return step ? { text: step.label, tone: "live" } : null;
}

/**
 * What a thread's row says about its agent when that beats branch and time: the step it is on, what it is waiting
 * for, or what a finished turn came to. A cloud thread first says how it is being set up or moved. `run` is the
 * thread's live run, whose transcript the app already holds.
 */
export function threadHeadline(thread: Pick<ThreadSummary, "activity" | "unread"> & CloudRow, run: RunTranscript | undefined): ThreadHeadline | null {
  const cloud = run ? null : cloudHeadline(thread);
  if (cloud) return cloud;
  if (thread.activity === "waiting") {
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
