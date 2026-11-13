import { defaultHarnessId, harnessShortName, type ThreadSummary } from "@openorc/protocol";
import { useRef } from "react";
import { useRpcMutation } from "../lib/client";
import { BackgroundCommands } from "./BackgroundCommands";
import type { ComposerHandle } from "./Composer";
import { queueAfterStart } from "./CloudStart";
import { MessageQueue } from "./MessageQueue";

/**
 * What a thread shows over its composer of its own work in flight: the messages queued for the running turn, each able
 * to go now, leave the queue or go back to the composer, and the commands its agent left running. `error` is the last failed action of either,
 * for the composer's alert, and the handle of the composer a queued message goes back into. A task's conversation has neither.
 */
export function useThreadControls(thread: ThreadSummary | null, runCount: number, steer: { canSteer: boolean; reason: string | null; blocked?: string | null; onSent: () => void }) {
  // The thread's composer, which a queued message goes back into.
  const composer = useRef<ComposerHandle>(null);
  const unqueue = useRpcMutation("threads.unqueue");
  const sendQueued = useRpcMutation("threads.sendQueued");
  const stopCommand = useRpcMutation("threads.stopCommand");
  const queued = thread ? queueAfterStart(thread, runCount) : [];
  const queue = thread ? (
    <MessageQueue
      messages={queued}
      canSend={steer.canSteer}
      pending={sendQueued.isPending || unqueue.isPending}
      sendReason={steer.reason}
      retryBlocked={steer.blocked}
      agentName={harnessShortName(thread.agent ?? defaultHarnessId)}
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
    <BackgroundCommands commands={thread.backgroundCommands ?? []} pending={stopCommand.isPending} onStop={(commandId) => stopCommand.mutate({ id: thread.id, commandId })} />
  ) : null;
  return { queue, commands, composer, error: sendQueued.error ?? stopCommand.error ?? unqueue.error };
}
