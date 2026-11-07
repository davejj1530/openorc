import { cloudStartFailure, cloudStartSteps, failureParts, type StartingCloudThread } from "@openorc/client";
import { useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useRpcMutation } from "../client";
import { failureMessage } from "../failure";
import { cn } from "../ui/cn";
import { MONO } from "../ui/Mono";
import { Text } from "../ui/Text";
import { StepMark } from "./tools";

/** About ten lines of a log, so the card keeps its message and Try again in view with the details open. */
const DETAILS_HEIGHT = 200;

/**
 * A setup that failed: what went wrong in a line, Try again, which sends the waiting message again and so sets the
 * sandbox up anew, and what the sandbox printed, such as a daemon's log, only when asked for.
 */
function Failed({ thread, failure }: { thread: StartingCloudThread; failure: string }) {
  const retry = useRpcMutation("threads.sendQueued");
  const [open, setOpen] = useState(false);
  const message = thread.queued[0]!;
  const { headline, details } = failureParts(retry.error ? failureMessage(retry.error) : failure);
  return (
    <>
      <Text className="text-md">The cloud workspace did not start</Text>
      <Text accessibilityRole="alert" className="text-sm text-bad">
        {headline}
      </Text>
      <View className="flex-row items-center gap-1">
        <Pressable
          accessibilityRole="button"
          disabled={retry.isPending}
          onPress={() => retry.mutate({ id: thread.id, messageId: message.id })}
          className="h-control-md justify-center rounded-full bg-surface-2 px-4 active:bg-surface-3"
        >
          <Text className={cn("text-sm text-ink-2", retry.isPending && "text-ink-4")}>Try again</Text>
        </Pressable>
        {details ? (
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} className="h-control-md justify-center rounded-full px-3 active:bg-surface-2">
            <Text className="text-sm text-ink-3">{open ? "Hide details" : "Details"}</Text>
          </Pressable>
        ) : null}
      </View>
      {open && details ? (
        <ScrollView style={{ maxHeight: DETAILS_HEIGHT }} className="rounded-xl bg-surface-2" contentContainerClassName="p-3">
          <Text selectable className={cn(MONO, "text-ink-3")}>
            {details}
          </Text>
        </ScrollView>
      ) : null}
    </>
  );
}

/**
 * A thread that has run before while its sandbox is set up again, as when a message brings back one deleted or failed:
 * the step under way, in one line above the composer, so a slow send says what it waits for.
 */
export function CloudPreparing({ thread }: { thread: StartingCloudThread }) {
  const steps = cloudStartSteps(thread);
  const current = steps.find((step) => step.state === "running") ?? steps.at(-1)!;
  return (
    <View accessibilityLabel="Cloud workspace" accessibilityLiveRegion="polite" className="min-h-touch flex-row items-center gap-2.5 rounded-lg bg-surface px-3.5">
      <StepMark state="running" arrived={false} />
      <Text numberOfLines={1} className="min-w-0 flex-1 text-sm text-ink-2">
        {current.label}
      </Text>
      <Text className="text-sm tabular-nums text-ink-4">
        {steps.indexOf(current) + 1} of {steps.length}
      </Text>
    </View>
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
