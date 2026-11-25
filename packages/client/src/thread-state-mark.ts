import type { ThreadSummary } from "@openorc/protocol";
import type { ProjectActivity, ThreadMarkKind } from "./state-marks.js";
import { mentionLeads } from "./thread-collaboration.js";
import { MENTION_MARK, pullRequestMark, threadStatus, threadTreeStatus, type ThreadStatus } from "./thread-row.js";
import { toolCallPresentation, type Tone } from "./tool-presentation.js";
import type { Block, RunTranscript } from "./transcript.js";
import { isLive } from "./work-steps.js";

type MarkFields = Pick<ThreadSummary, "activity" | "session" | "unread" | "backgroundCommands" | "owner"> & Partial<Pick<ThreadSummary, "prUrl" | "prState">>;

/** The kind of work a step's tone is, as the cube moves for it. */
const WORK: Record<Tone, ThreadMarkKind> = {
  read: "reading",
  memory: "reading",
  context: "reading",
  edit: "editing",
  run: "running",
  search: "searching",
  web: "searching",
  task: "delegating",
  think: "thinking",
  plan: "thinking",
  neutral: "working",
};

/** The kind of work a step under way is, as the cube moves for it. */
export function workMarkKind(step: Block | undefined): ThreadMarkKind {
  if (step?.kind === "thinking") return "thinking";
  if (step?.kind === "message") return "replying";
  if (step?.kind === "tool") return step.subagent ? "delegating" : WORK[toolCallPresentation(step.name, step.input).tone];
  return "working";
}

/** What it stopped for: a question, or leave to do something. */
function askKind(run: RunTranscript | undefined): ThreadMarkKind {
  const ask = run?.blocks.findLast((block) => block.kind === "approval" && !block.decision);
  return ask?.kind === "approval" && ask.approvalKind !== "user_input" ? "approval" : "question";
}

/**
 * The cube a thread's row leads with, and what it says aloud: the reader's unread mention first, then the thread's
 * state or its sub threads' when that is more pressing, then its pull request while it rests. `run` is its live run,
 * which names the work under way. Null when there is nothing to say.
 */
export function threadStateMark(
  thread: MarkFields,
  { subthreads = null, run }: { subthreads?: ThreadStatus | null; run?: RunTranscript | undefined } = {},
): { kind: ThreadMarkKind; label: string } | null {
  const status = threadTreeStatus(threadStatus(thread), subthreads);
  if (mentionLeads(thread, status)) return { kind: "mention", label: MENTION_MARK.label };
  if (!status) {
    const pull = pullRequestMark({ prUrl: thread.prUrl ?? null, prState: thread.prState ?? null });
    return pull && { kind: pull.state, label: pull.label };
  }
  const kinds: Record<ThreadStatus["kind"], () => ThreadMarkKind> = {
    // Its own turn names its work; a parent that only waits on its sub threads shows them at work.
    running: () => (thread.activity === "running" ? workMarkKind(run?.blocks.findLast(isLive)) : "delegating"),
    waiting: () => askKind(run),
    "waiting-other": () => "waiting",
    failed: () => "failed",
    unread: () => "done",
    background: () => "background",
  };
  return { kind: kinds[status.kind](), label: status.label };
}

/** What a project's mark shows of its threads: one that needs the person before any at work. */
export function projectActivity(threads: readonly Pick<ThreadSummary, "activity">[], waiting: number): ProjectActivity {
  if (waiting) return "attention";
  return threads.some((thread) => thread.activity === "running") ? "working" : "quiet";
}
