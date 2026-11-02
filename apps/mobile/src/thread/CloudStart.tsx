import { cloudStartFailure, cloudStartSteps, type StartingCloudThread } from "@openorc/client";
import { useRef } from "react";
import { Pressable, View } from "react-native";
import { useRpcMutation } from "../client";
import { failureMessage } from "../failure";
import { cn } from "../ui/cn";
import { Text } from "../ui/Text";
import { StepMark } from "./tools";

/** A setup that failed: why, and Try again, which sends the waiting message again and so sets the sandbox up anew. */
function Failed({ thread, failure }: { thread: StartingCloudThread; failure: string }) {
  const retry = useRpcMutation("threads.sendQueued");
  const message = thread.queued[0]!;
  return (
    <>
      <Text className="text-md">The cloud workspace did not start</Text>
      <Text accessibilityRole="alert" className="text-sm text-bad">
        {retry.error ? failureMessage(retry.error) : failure}
      </Text>
      <Pressable
        accessibilityRole="button"
        disabled={retry.isPending}
        onPress={() => retry.mutate({ id: thread.id, messageId: message.id })}
        className="h-control-md self-start justify-center rounded-full bg-surface-2 px-4 active:bg-surface-3"
      >
        <Text className={cn("text-sm text-ink-2", retry.isPending && "text-ink-4")}>Try again</Text>
      </Pressable>
    </>
  );
}

/** The sandbox's setup as the work rail's steps; a step that finishes while the card is open lands its check. */
function Steps({ thread }: { thread: StartingCloudThread }) {
  const steps = cloudStartSteps(thread);
  const doneAtOpen = useRef(new Set(steps.filter((step) => step.state === "done").map((step) => step.step)));
  return (
    <>
      <Text className="text-md">Setting up the cloud workspace</Text>
      <View>
        {steps.map(({ step, label, state }) => (
          <View key={step} className="flex-row items-center gap-2.5">
            <StepMark state={state} arrived={!doneAtOpen.current.has(step)} />
            <Text className={cn("text-sm text-ink-2", state === "pending" && "text-ink-4")}>{label}</Text>
          </View>
        ))}
      </View>
    </>
  );
}

/**
 * A starting cloud thread, in place of its empty transcript: the sandbox's setup as steps, or why it failed, over the
 * message that goes to the agent once the sandbox is ready.
 */
export function CloudStart({ thread }: { thread: StartingCloudThread }) {
  const failure = cloudStartFailure(thread);
  const message = thread.queued[0];
  return (
    <View className="flex-1 justify-center px-5">
      <View accessibilityLabel="Cloud workspace" className="gap-3 rounded-3xl bg-surface px-4 pb-4 pt-3.5">
        {failure ? <Failed thread={thread} failure={failure} /> : <Steps thread={thread} />}
        <Text numberOfLines={4} className="text-sm text-ink-3">
          {message?.text.trim() || "Attached images"}
        </Text>
      </View>
    </View>
  );
}
