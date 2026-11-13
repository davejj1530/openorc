import { defaultHarnessId, harnessShortName, type ThreadSummary } from "@openorc/protocol";
import { useRpcMutation } from "../lib/client";
import { BackgroundCommands } from "./BackgroundCommands";
import { queueAfterStart } from "./CloudStart";
import { MessageQueue } from "./MessageQueue";

/**
 * What a thread shows over its composer of its own work in flight: the messages queued for the running turn, each able
 * to go now or leave the queue, and the commands its agent left running. `error` is the last failed action of either,
 * for the composer's alert. A task's conversation has neither.
 */
export function useThreadControls(thread: ThreadSummary | null, runCount: number, steer: { canSteer: boolean; reason: string | null; onSent: () => void }) {
  const unqueue = useRpcMutation("threads.unqueue");
  const sendQueued = useRpcMutation("threads.sendQueued");
  const stopCommand = useRpcMutation("threads.stopCommand");
  const queue = thread ? (
    <MessageQueue
      messages={queueAfterStart(thread, runCount)}
      canSend={steer.canSteer}
      pending={sendQueued.isPending || unqueue.isPending}
      sendReason={steer.reason}
      agentName={harnessShortName(thread.agent ?? defaultHarnessId)}
      onSend={(messageId) => {
        steer.onSent();
        sendQueued.mutate({ id: thread.id, messageId });
      }}
      onRemove={(messageId) => unqueue.mutate({ id: thread.id, messageId })}
    />
  ) : null;
  const commands = thread ? (
    <BackgroundCommands commands={thread.backgroundCommands ?? []} pending={stopCommand.isPending} onStop={(commandId) => stopCommand.mutate({ id: thread.id, commandId })} />
  ) : null;
  return { queue, commands, error: sendQueued.error ?? stopCommand.error ?? unqueue.error };
}
