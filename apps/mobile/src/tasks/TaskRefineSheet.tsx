import { commentRecipientKey } from "@openorc/protocol";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { useRpcMutation } from "../client";
import { Field, SheetPill } from "../changes/SheetParts";
import { HarnessLogo } from "../ui/HarnessLogo";
import { haptic } from "../ui/haptics";
import { SheetHeader } from "../ui/SheetHeader";
import { useSheetBottom } from "../ui/sheet-bottom";
import { Text } from "../ui/Text";
import { PillMenu } from "./TaskProperties";
import { useRefiners } from "./use-task-refine";

const back = () => router.back();
/** The instruction grows to about five lines, then scrolls. */
const INSTRUCTION_MAX = 20 * 5;
const NO_AGENT = "Sign in to an agent on your Mac to refine this task.";

/**
 * Starts a Refine of one task, over its screen: what should change, which may be left to the agent, and the model that
 * refines. The model last chosen comes back. A Claude model refines on the task's own account, as the Mac decides.
 */
export function TaskRefineSheet() {
  const { id, again } = useLocalSearchParams<{ id: string; again?: string }>();
  const bottom = useSheetBottom(16);
  const start = useRpcMutation("tasks.refine.start");
  const { options, chosen, choose } = useRefiners();
  const [instruction, setInstruction] = useState("");
  const [asked, setAsked] = useState(false);
  const locked = start.isPending;
  const names = Object.fromEntries(options.map((option) => [commentRecipientKey(option.recipient), option.name]));
  const refine = () => {
    if (!chosen) {
      haptic.warn();
      return setAsked(true);
    }
    start.mutate(
      { taskId: id, recipient: chosen.recipient, instruction: instruction.trim(), again: again !== undefined },
      {
        onSuccess: () => {
          haptic.confirm();
          back();
        },
        onError: () => haptic.warn(),
      },
    );
  };
  return (
    <>
      <Stack.Screen options={{ gestureEnabled: !locked }} />
      <ScrollView keyboardShouldPersistTaps="handled" scrollEnabled={false} className="bg-bg" contentContainerStyle={{ paddingBottom: bottom }} onAccessibilityEscape={() => !locked && back()}>
        <SheetHeader title={again ? "Refine again" : "Refine this task"} onClose={back} locked={locked} />
        <View className="gap-3 px-5 pt-1">
          <Field>
            <TextInput
              multiline
              autoFocus
              editable={!locked}
              value={instruction}
              onChangeText={setInstruction}
              maxLength={4000}
              placeholder="What should change? Optional"
              accessibilityLabel="What should change?"
              className="px-4 py-3 font-sans text-md leading-5 text-ink"
              placeholderTextColorClassName="accent-ink-4"
              style={{ maxHeight: INSTRUCTION_MAX + 24 }}
            />
          </Field>
          {chosen ? (
            <View className="flex-row">
              <PillMenu
                name="Refine with"
                value={commentRecipientKey(chosen.recipient)}
                values={Object.keys(names)}
                words={names}
                icon={<HarnessLogo agent={chosen.recipient.agent} size={16} />}
                onChange={choose}
              />
            </View>
          ) : null}
          {asked && !chosen ? <Text className="px-4 text-sm text-ink-3">{NO_AGENT}</Text> : null}
          {start.error ? (
            <Text accessibilityRole="alert" selectable className="px-4 text-sm text-bad">
              {start.error.message}
            </Text>
          ) : null}
          <SheetPill label={locked ? "Starting…" : "Refine"} dim={!chosen} running={locked} onPress={refine} />
        </View>
      </ScrollView>
    </>
  );
}
