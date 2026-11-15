import { HOSTED_REASONS, type RoutedMethod, type RpcParams, type RpcResults } from "@openorc/protocol";
import type { Threads } from "./threads.js";
import { toRuns } from "./translate.js";
import * as sends from "./sends.js";
import * as review from "./thread-review.js";
import { lastMessage } from "./thread-history.js";
import { capabilities } from "./capabilities.js";
import { nativeRuns, stopNative } from "./subthreads.js";
import * as together from "./collaboration.js";
import * as shared from "./shared-sends.js";

type Answer<M extends RoutedMethod> = (threads: Threads, params: RpcParams<M>) => Promise<RpcResults[M]> | RpcResults[M];

/** A call a hosted thread does not take, with the words the person reads. */
const refused = (words: string) => ({ refused: words }) as const;
/** A call the core's router never asks a place: it names a task, which no place holds, or is this Mac's own to answer. */
const NOT_ASKED = { notAsked: true } as const;

export const NOT_YET = refused("This isn't on OpenOrc Cloud yet.");
const NO_FILES = refused("An OpenOrc Cloud thread's files aren't on this Mac.");

/**
 * What a hosted thread does with each of the app's calls that name a thread, a run or a task: answers it, refuses it in
 * words, or is never asked it. Total over `RoutedMethod`, so a new such call does not compile until someone decides.
 */
export const ANSWERS: { [M in RoutedMethod]: Answer<M> | ReturnType<typeof refused> | typeof NOT_ASKED } = {
  "hosted.capabilities": capabilities,
  "hosted.review.changes": review.changes,
  "hosted.review.turn": review.turn,
  "hosted.review.file": review.file,
  "hosted.review.state": review.state,
  "hosted.review.action": review.action,
  "threads.collaboration": together.collaboration,
  "threads.authors": together.authors,
  "threads.people": together.people,
  "threads.startQueued": (threads, params) => shared.startQueued({ ...threads.calls, starts: threads.starts }, params),
  "threads.retrySave": (threads, params) => shared.retrySave(threads.calls, params),
  "threads.get": (threads, { id }) => threads.summary(id),
  "runs.listForThread": nativeRuns,
  "events.page": (threads, params) => threads.page(params),
  "events.listForRun": (threads, { runId, afterSeq }) => threads.eventsAfter(runId, afterSeq ?? 0),
  "threads.stopCommand": (threads, { id, commandId }) => threads.stopCommand(id, commandId),
  "threads.update": (threads, { id, patch }) => threads.update(id, patch),
  // Asked only of a start that chose OpenOrc Cloud.
  "threads.start": (threads, params) => threads.startThread(params),
  // The composer's sends, the queue, Stop and the answers to asks: sends.ts.
  "runs.start": async (threads, params) => {
    await sends.start(threads.calls, params);
    return toRuns(threads.row(params.threadId!), threads.reach)[0]!;
  },
  "runs.send": (threads, params) => sends.send(threads.calls, params).then(() => null),
  "threads.queue": (threads, params) => sends.queue(threads.calls, params),
  "threads.unqueue": (threads, params) => sends.unqueue(threads.calls, params),
  "threads.sendQueued": (threads, params) => sends.sendQueued(threads.calls, params),
  "runs.interrupt": (threads, params) => sends.stop(threads.calls, params).then(() => null),
  "approvals.resolve": (threads, params) => sends.answer(threads.calls, params).then(() => null),
  "threads.ready": (threads, params) => sends.ready(threads.calls, threads.readied, params).then(() => null),
  "threads.messages": refused(HOSTED_REASONS.search),
  "threads.lastMessage": lastMessage,
  "threads.plans": refused(HOSTED_REASONS.plans),
  "threads.checkpoints": refused(HOSTED_REASONS.checkpoints),
  "orclings.reactions": refused(HOSTED_REASONS.reactions),
  "review.comments.list": refused(HOSTED_REASONS.comments),
  "tasks.list": refused(HOSTED_REASONS.tasks),
  "review.threadDiff": review.legacyDiff,

  "threads.delete": (threads, { id }) => threads.remove(id),
  "threads.implementPlan": refused(HOSTED_REASONS.plans),
  "threads.exportPlan": refused(HOSTED_REASONS.plans),
  "threads.switchClaudeAccount": refused(HOSTED_REASONS.claudeAccount),
  "threads.compact": refused(HOSTED_REASONS.compact),
  "threads.send": refused("Sending to another cloud thread isn't available yet."),
  "threads.turnChanges": review.legacyTurn,
  "threads.fork": refused(HOSTED_REASONS.fork),
  "subagents.stop": stopNative,
  "runs.close": refused("Closing a cloud agent session isn't available yet."),
  "events.toolOutput": refused(HOSTED_REASONS.toolOutput),
  "tasks.create": refused(HOSTED_REASONS.tasks),
  "orclings.ask": refused("Orclings aren't available in this cloud thread yet."),
  "orclings.assign": refused("Orclings aren't available in this cloud thread yet."),
  "orclings.react": refused(HOSTED_REASONS.reactions),
  "orclings.origins": refused("Orclings aren't available in this cloud thread yet."),
  "orclings.groups.send": refused("Orclings aren't available in this cloud thread yet."),
  "orclings.groups.delete": refused("Orclings aren't available in this cloud thread yet."),
  "review.comments.add": refused(HOSTED_REASONS.comments),
  "review.comments.remove": refused(HOSTED_REASONS.comments),
  "review.comments.send": refused(HOSTED_REASONS.comments),
  "review.threadChanges": review.legacyChanges,
  "review.threadFileDiff": review.legacyFile,
  "review.commitThread": review.commit,
  "review.pushThread": review.push,
  "review.createThreadPr": review.pullRequest,
  "review.threadPrTemplate": refused("Pull request templates aren't available in this cloud thread yet."),
  "git.threadLog": refused(HOSTED_REASONS.commitHistory),
  "git.commitRange": refused(HOSTED_REASONS.commitHistory),
  "git.threadPushState": NO_FILES,
  "threads.moveWorkspace": NO_FILES,
  "threads.movePreview": NO_FILES,
  "threads.restore": refused(HOSTED_REASONS.checkpoints),
  "threads.restorePreview": refused(HOSTED_REASONS.checkpoints),
  "instructions.list": refused(HOSTED_REASONS.instructions),
  "instructions.save": refused(HOSTED_REASONS.instructions),
  "preview.state": refused(HOSTED_REASONS.previewServer),
  "mcpApps.open": refused(HOSTED_REASONS.interactiveApp),
  "tasks.get": NOT_ASKED,
  "tasks.update": NOT_ASKED,
  "tasks.delete": NOT_ASKED,
  "tasks.start": NOT_ASKED,
  "tasks.openThread": NOT_ASKED,
  "tasks.executionThread": NOT_ASKED,
  "tasks.prepareWorkspace": NOT_ASKED,
  "tasks.comments.list": NOT_ASKED,
  "tasks.comments.post": NOT_ASKED,
  "tasks.comments.retry": NOT_ASKED,
  "tasks.comments.cancel": NOT_ASKED,
  "tasks.comments.execute": NOT_ASKED,
  "runs.listForTask": NOT_ASKED,
  "memory.forTask": NOT_ASKED,
  "workspace.cleanup": NOT_ASKED,
  "workspace.removalImpact": NOT_ASKED,
  "workspace.usage": NOT_ASKED,
  "review.diff": NOT_ASKED,
  "review.snapshots": NOT_ASKED,
  "review.markReviewed": NOT_ASKED,
  "review.commit": NOT_ASKED,
  "review.checkoutState": NOT_ASKED,
  "review.exportPatch": NOT_ASKED,
  "review.push": NOT_ASKED,
  "review.createPr": NOT_ASKED,
  "git.log": NOT_ASKED,
};
