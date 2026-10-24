import type { ReactNode } from "react";
import { Keyboard, Pressable, TextInput, View } from "react-native";
import { Plus } from "../generated/icons";
import { ComposerChips } from "./ComposerChips";
import { ComposerImages } from "./ComposerImages";
import type { Draft } from "./drafts";
import type { ComposerSettings } from "./settings-bridge";

/** The prompt grows with what is written up to six of the lines it draws (leading-5), then scrolls. */
const PROMPT_MAX = 20 * 6;

export interface ComposerPlaneProps {
  composerId: string;
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
 * model and mode on the left and the actions on the right.
 */
export function ComposerPlane({ composerId, settings, draft, uploading, placeholder, autoFocus, onFocusChange, onText, onRemoveImage, onAttach, children }: ComposerPlaneProps) {
  return (
    <View className="gap-3.5 rounded-3xl bg-composer-input pb-3 pl-4 pr-3 pt-3.5">
      <ComposerImages images={draft.images} uploading={uploading} onRemove={onRemoveImage} />
      <TextInput
        multiline
        autoFocus={autoFocus}
        value={draft.text}
        onChangeText={onText}
        onFocus={() => onFocusChange?.(true)}
        onBlur={() => onFocusChange?.(false)}
        placeholder={placeholder}
        accessibilityLabel="Message"
        className="p-0 font-sans text-md leading-5 text-ink"
        placeholderTextColorClassName="accent-ink-4"
        style={{ maxHeight: PROMPT_MAX }}
      />
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
  );
}
