import type { FileScope } from "@openorc/protocol";
import { useState, type ReactNode } from "react";
import { Keyboard, Text as NativeText, Pressable, TextInput, View } from "react-native";
import { Plus } from "../generated/icons";
import { fonts } from "../generated/tokens";
import { ComposerChips } from "./ComposerChips";
import { ComposerImages } from "./ComposerImages";
import type { Draft } from "./drafts";
import type { ComposerSettings } from "./settings-bridge";
import { SkillPicker } from "./SkillPicker";
import { useSkillPicker } from "./use-skill-picker";

/** The prompt grows with what is written up to six of the lines it draws (leading-5), then scrolls. */
const PROMPT_MAX = 20 * 6;

export interface ComposerPlaneProps {
  composerId: string;
  /** Where the conversation works, whose skills `/` offers: the thread, or the project before it exists. */
  skillScope: FileScope | null;
  settings: ComposerSettings;
  draft: Draft;
  uploading: number;
  placeholder: string;
  autoFocus?: boolean;
  /** The prompt took or gave up the keyboard. */
  onFocusChange?: (focused: boolean) => void;
  onText: (text: string) => void;
  onRemoveImage: (path: string) => void;
  onAttach: () => void;
  /** The bar's end: activity, then the actions, the ink pill last. */
  children: ReactNode;
}

/**
 * The composer's one r20 plane, for a thread and for a new one: the draft's images, the prompt, and a bar with attach,
 * model and mode on the left and the actions on the right. While the prompt has the keyboard, a `/` word opens the
 * skill picker in a piece above it.
 */
export function ComposerPlane({ composerId, skillScope, settings, draft, uploading, placeholder, autoFocus, onFocusChange, onText, onRemoveImage, onAttach, children }: ComposerPlaneProps) {
  const [focused, setFocused] = useState(Boolean(autoFocus));
  const picker = useSkillPicker({ scope: skillScope, agent: settings.choice?.agent, claudeAccountId: settings.claudeAccount?.chosen ?? settings.claudeAccountId, text: draft.text, onText });
  return (
    <>
      {focused ? <SkillPicker matches={picker.matches} notice={picker.notice} onPick={picker.pick} /> : null}
      <View className="gap-3.5 rounded-3xl bg-composer-input pb-3 pl-4 pr-3 pt-3.5">
        <ComposerImages images={draft.images} uploading={uploading} onRemove={onRemoveImage} />
        <TextInput
          multiline
          autoFocus={autoFocus}
          onChangeText={onText}
          selection={picker.selection}
          onSelectionChange={(event) => picker.onSelectionChange(event.nativeEvent.selection.end)}
          onFocus={() => {
            setFocused(true);
            onFocusChange?.(true);
          }}
          onBlur={() => {
            setFocused(false);
            onFocusChange?.(false);
          }}
          placeholder={placeholder}
          accessibilityLabel="Message"
          className="p-0 font-sans text-md leading-5 text-ink"
          placeholderTextColorClassName="accent-ink-4"
          style={{ maxHeight: PROMPT_MAX }}
        >
          {/* The prompt draws its own runs, so a skill in the Bold face moves nothing out from under the caret. */}
          {picker.segments.map((segment, index) =>
            segment.skill ? (
              <NativeText key={index} className="text-mention-ink" style={{ fontFamily: fonts.bold }}>
                {segment.text}
              </NativeText>
            ) : (
              <NativeText key={index}>{segment.text}</NativeText>
            ),
          )}
        </TextInput>
        <View className="flex-row items-center justify-between gap-2">
          <View className="min-w-0 flex-1 flex-row items-center gap-1.5">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Attach image"
              onPress={() => {
                // The photo picker and the camera come up over the composer, so the keyboard goes first.
                Keyboard.dismiss();
                onAttach();
              }}
              hitSlop={8}
              className="h-control-sm w-7 items-center justify-center rounded-full active:bg-surface-2"
            >
              <Plus size={16} className="text-ink-4" />
            </Pressable>
            <ComposerChips composerId={composerId} settings={settings} />
          </View>
          <View className="flex-row items-center gap-2.5">{children}</View>
        </View>
      </View>
    </>
  );
}
