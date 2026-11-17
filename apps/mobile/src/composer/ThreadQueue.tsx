import { harnessShortName, isHarnessId, type QueuedMessage, type ThreadSummary } from "@openorc/protocol";
import { useRpcMutation } from "../client";
import { ownPaused, threadTogetherOf, turnSeen, useTogether } from "../thread/cloud-together";
import { Text } from "../ui/Text";
import { MessageQueue } from "./MessageQueue";

/** Messages waiting for the running turn, each able to go now or leave the queue. */
export function ThreadQueue({ thread, queued, canSteer, typing, onSent }: { thread: ThreadSummary; queued: QueuedMessage[]; canSteer: boolean; typing: boolean; onSent: () => void }) {
  const unqueue = useRpcMutation("threads.unqueue");
  const sendQueued = useRpcMutation("threads.sendQueued");
  const startQueued = useRpcMutation("threads.startQueued");
  // In a cloud thread it joins only the turn this screen saw, as a message sent now does.
  const together = useTogether();
  const failure = (unqueue.error ?? sendQueued.error ?? startQueued.error)?.message;
  return (
    <>
      <MessageQueue
        messages={queued}
        canSend={canSteer}
        pending={unqueue.isPending || sendQueued.isPending || startQueued.isPending}
        agentName={harnessShortName(isHarnessId(thread.agent) ? thread.agent : "codex")}
        typing={typing}
        onSend={(messageId) => {
          sendQueued.mutate({ id: thread.id, messageId, ...turnSeen(together) });
          onSent();
        }}
        onRemove={(messageId) => unqueue.mutate({ id: thread.id, messageId })}
        paused={ownPaused(threadTogetherOf(thread))}
        onStart={(messageId) => {
          startQueued.mutate({ threadId: thread.id, messageId });
          onSent();
        }}
      />
      {failure ? <Text className="px-1 text-sm text-bad">{failure}</Text> : null}
    </>
  );
}
