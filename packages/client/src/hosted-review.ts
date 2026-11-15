import type { HostedFileDiff, HostedReviewAction, HostedReviewState, ThreadSummary } from "@openorc/protocol";
import type { RunTranscript } from "./transcript.js";
import { threadReadOnlyReason } from "./hosted-send.js";
import { threadTogether, writesAsCreator } from "./thread-collaboration.js";

export const hostedReviewPending = (action: HostedReviewAction | null | undefined): boolean => action?.state === "waiting" || action?.state === "running";

export function hostedActionLine(action: HostedReviewAction): string {
  if (action.line) return action.line;
  const name = { commit: "Commit", push: "Push", pull_request: "Pull request" }[action.kind];
  if (action.state === "waiting") return `${name} is waiting for the turn to finish.`;
  if (action.state === "running") return `${name} is running.`;
  if (action.state === "refused") return `${name} was refused. Try again after checking your cloud account.`;
  if (action.state === "failed") return `${name} failed. Try again.`;
  switch (action.result?.kind) {
    case "committed":
      return `Committed ${action.result.sha.slice(0, 7)}`;
    case "nothing_to_commit":
      return "Nothing to commit.";
    case "pushed":
      return `Pushed ${action.result.branch}`;
    case "up_to_date":
      return "The branch is up to date.";
    case "nothing_to_push":
      return "Nothing to push.";
    case "pull_request":
      return `Opened pull request #${action.result.number}`;
    default:
      return "The server hasn't returned the result yet.";
  }
}

/**
 * Why this reader cannot act on the thread's work now. Where the server says who may write, a person who may write acts
 * as they would take their own turn, the work moving to them, and is held in the server's words while something holds
 * that turn; under the server's older rule, and from a server that predates working together, only the starter acts.
 */
function actionBlock(thread: Pick<ThreadSummary, "owner">): string | null {
  const state = threadTogether(thread);
  if (!state || writesAsCreator(thread)) return state ? null : threadReadOnlyReason(thread);
  if (state.handoff) return state.handoff.message;
  return state.canWrite ? null : threadReadOnlyReason(thread);
}

/** A saved base diff is never a count of what a commit would include. */
export function hostedPublishReason(thread: Pick<ThreadSummary, "owner">, state: HostedReviewState | undefined): string | null {
  if (thread.owner?.reach !== "live") return "OpenOrc Cloud can't be reached.";
  const readOnly = actionBlock(thread);
  if (readOnly) return readOnly;
  if (!state) return "Refresh changes before continuing.";
  if (state.actions.some(hostedReviewPending)) return "Wait for the current action to finish.";
  return null;
}

/** PatchDiff expects headers; the stored file route contains only hunks. */
export function hostedFilePatch(file: HostedFileDiff): string {
  if (!file.patch) return "";
  const before = file.oldPath ?? file.path;
  const mode = patchMode(file.status);
  return `diff --git a/${before} b/${file.path}\n${mode}--- ${file.status === "added" ? "/dev/null" : `a/${before}`}\n+++ ${file.status === "deleted" ? "/dev/null" : `b/${file.path}`}\n${file.patch}`;
}

function patchMode(status: HostedFileDiff["status"]): string {
  if (status === "added") return "new file mode 100644\n";
  return status === "deleted" ? "deleted file mode 100644\n" : "";
}

/** Hosted turns name their saved changes in the existing completion block, without inventing restore checkpoints. */
export function hostedTurnCards(transcripts: readonly (RunTranscript | undefined)[]): Map<string, { checkpointId: string; previousCheckpointId: null; paths: string[]; hosted: true }> {
  const cards = new Map<string, { checkpointId: string; previousCheckpointId: null; paths: string[]; hosted: true }>();
  for (const run of transcripts) {
    if (!run) continue;
    for (const block of run.blocks) {
      if (block.kind !== "status" || block.boundary !== "turn" || !block.id.startsWith("turn-")) continue;
      cards.set(block.id, { checkpointId: block.id.slice(5), previousCheckpointId: null, paths: [], hosted: true });
    }
  }
  return cards;
}
