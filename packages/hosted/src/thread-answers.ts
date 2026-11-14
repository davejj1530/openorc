import type { RoutedMethod, RpcParams, RpcResults } from "@openorc/protocol";
import type { Threads } from "./threads.js";
import { toRuns } from "./translate.js";
import * as sends from "./sends.js";
import * as review from "./thread-review.js";

type Answer<M extends RoutedMethod> = (threads: Threads, params: RpcParams<M>) => Promise<RpcResults[M]> | RpcResults[M];

/** A call a hosted thread does not take, with the words the person reads. */
const refused = (words: string) => ({ refused: words }) as const;
/** A call the core's router never asks a place: it names a task, which no place holds, or is this Mac's own to answer. */
const NOT_ASKED = { notAsked: true } as const;

export const NOT_YET = refused("This isn't on OpenOrc Cloud yet.");
const NO_FILES = refused("An OpenOrc Cloud thread's files aren't on this Mac.");
const STAYS = refused("An OpenOrc Cloud thread stays on OpenOrc Cloud.");

/**
 * What a hosted thread does with each of the app's calls that name a thread, a run or a task: answers it, refuses it in
 * words, or is never asked it. Total over `RoutedMethod`, so a new such call does not compile until someone decides.
 */
export const ANSWERS: { [M in RoutedMethod]: Answer<M> | ReturnType<typeof refused> | typeof NOT_ASKED } = {
  "hosted.review.changes": review.changes,
  "hosted.review.turn": review.turn,
  "hosted.review.file": review.file,
  "hosted.review.state": review.state,
  "hosted.review.action": review.action,
  "threads.get": (threads, { id }) => threads.summary(id),
  "runs.listForThread": (threads, { threadId }) => toRuns(threads.row(threadId), threads.reach),
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
  // Reads the thread view makes as it opens, for parts the server does not serve yet: their empty answers.
  "threads.messages": () => [],
  "threads.lastMessage": () => null,
  "threads.plans": () => [],
  "threads.checkpoints": () => [],
  "orclings.reactions": () => [],
  "review.comments.list": () => [],
  "tasks.list": () => [],
  "review.threadDiff": review.legacyDiff,

  "threads.delete": (threads, { id }) => threads.remove(id),
  "threads.implementPlan": NOT_YET,
  "threads.exportPlan": NOT_YET,
  "threads.switchClaudeAccount": refused("An OpenOrc Cloud thread runs on your Claude sign-in there."),
  "threads.compact": NOT_YET,
  "threads.send": NOT_YET,
  "threads.turnChanges": review.legacyTurn,
  "threads.fork": NOT_YET,
  "subagents.stop": NOT_YET,
  "runs.close": NOT_YET,
  "events.toolOutput": NOT_YET,
  "tasks.create": NOT_YET,
  "orclings.ask": NOT_YET,
  "orclings.assign": NOT_YET,
  "orclings.react": NOT_YET,
  "orclings.origins": NOT_YET,
  "orclings.groups.send": NOT_YET,
  "orclings.groups.delete": NOT_YET,
  "review.comments.add": NOT_YET,
  "review.comments.remove": NOT_YET,
  "review.comments.send": NOT_YET,
  "review.threadChanges": review.legacyChanges,
  "review.threadFileDiff": review.file,
  "review.commitThread": review.commit,
  "review.pushThread": review.push,
  "review.createThreadPr": review.pullRequest,
  "review.threadPrTemplate": refused("Pull request templates aren't available in this cloud thread yet."),
  "git.threadLog": NO_FILES,
  "git.commitRange": NO_FILES,
  "git.threadPushState": NO_FILES,
  "threads.moveWorkspace": NO_FILES,
  "threads.movePreview": NO_FILES,
  "threads.restore": NO_FILES,
  "threads.restorePreview": NO_FILES,
  "cloud.move": STAYS,

  "cloud.bringToMac": NOT_ASKED,
  "cloud.keep": NOT_ASKED,
  "cloud.openOnMac": NOT_ASKED,
  "cloud.closeOnMac": NOT_ASKED,
  "threads.snapshot": NOT_ASKED,
  "instructions.list": NOT_ASKED,
  "instructions.save": NOT_ASKED,
  "preview.state": NOT_ASKED,
  "mcpApps.open": NOT_ASKED,
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
