import { canStopCommands, personFirst, queuedBy, startBlock, threadTogether, togetherActivity, withOthers, writesAsCreator } from "@openorc/client";
import { defaultHarnessId, harnessShortName, type ThreadSummary } from "@openorc/protocol";
import type { RefObject } from "react";
import { useRpcMutation } from "../lib/client";
import { BackgroundCommands } from "./BackgroundCommands";
import type { ComposerHandle } from "./Composer";
import { MessageQueue, type QueuedBy } from "./MessageQueue";

/**
 * What a thread shows over its composer of its own work in flight: the messages queued for the running turn, each able
 * to go now, leave the queue or go back to the composer, and the commands its agent left running. `error` is the last failed action of either,
 * for the composer's alert, and the handle of the composer a queued message goes back into. A task's conversation has neither.
 */
export function useThreadControls(
  thread: ThreadSummary | null,
  steer: { canSteer: boolean; reason: string | null; blocked?: string | null; onSent: () => void },
  // The thread's composer, which a queued message goes back into.
  composer: RefObject<ComposerHandle | null>,
) {
  const unqueue = useRpcMutation("threads.unqueue");
  const sendQueued = useRpcMutation("threads.sendQueued");
  const startQueued = useRpcMutation("threads.startQueued");
  const stopCommand = useRpcMutation("threads.stopCommand");
  const queued = thread?.queued ?? [];
  const queue = thread ? (
    <MessageQueue
      messages={queued}
      canSend={steer.canSteer}
      pending={sendQueued.isPending || unqueue.isPending || startQueued.isPending}
      sendReason={steer.reason}
      retryBlocked={steer.blocked}
      agentName={harnessShortName(thread.agent ?? defaultHarnessId)}
      people={queuePeople(thread)}
      onStart={(messageId) => {
        steer.onSent();
        startQueued.mutate({ threadId: thread.id, messageId });
      }}
      onSend={(messageId) => {
        steer.onSent();
        sendQueued.mutate({ id: thread.id, messageId });
      }}
      onRemove={(messageId) => unqueue.mutate({ id: thread.id, messageId })}
      // Back to the composer only once it has left the queue, so the turn ending meanwhile can never send it twice.
      onEdit={(messageId) => {
        const message = queued.find((each) => each.id === messageId);
        if (message) unqueue.mutate({ id: thread.id, messageId }, { onSuccess: () => composer.current?.append(message.text, message.attachments) });
      }}
    />
  ) : null;
  const commands = thread ? (
    <BackgroundCommands
      commands={thread.backgroundCommands ?? []}
      pending={stopCommand.isPending}
      canStop={canStopCommands(thread)}
      onStop={(commandId) => stopCommand.mutate({ id: thread.id, commandId })}
    />
  ) : null;
  return { queue, commands, composer, error: sendQueued.error ?? startQueued.error ?? stopCommand.error ?? unqueue.error };
}

/**
 * In a cloud thread whose server names the queue's authors: each message's author when others are in the thread, and
 * the server's word on what the reader may do to it. The thread's creator keeps every action under the server's older
 * rule until shared writing opens. The hint names whose turn the queue waits on, when it is someone else's.
 */
function queuePeople(thread: ThreadSummary): { hint: string | null; pausedHint: string | null; of(messageId: string): QueuedBy | null } | undefined {
  const together = threadTogether(thread);
  if (!together) return undefined;
  const shared = withOthers(thread);
  const sender = together.live?.sender;
  const hint = thread.activity === "running" && togetherActivity(thread) && sender ? `After ${personFirst(sender)}'s turn` : null;
  return {
    hint,
    // Why the reader's own message waits paused, in the server's words; only its author is told.
    pausedHint: together.queue.find((queued) => queued.paused && queued.pause)?.pause?.message ?? null,
    of: (messageId) => {
      const by = queuedBy(thread, messageId);
      if (!by) return null;
      const mine = by.author?.id === together.viewer.id;
      const rights = writesAsCreator(thread) ? { canEdit: true, canRemove: true, mine: true } : { canEdit: by.canEdit, canRemove: by.canRemove, mine };
      const held = { paused: by.paused, canStart: by.canStart, startBlocked: by.canStart ? null : startBlock(thread) };
      return { ...rights, ...held, ...(shared && { author: by.author }) };
    },
  };
}
