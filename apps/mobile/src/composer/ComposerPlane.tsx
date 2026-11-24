import type { FileScope } from "@openorc/protocol";
import { useState, type ReactNode } from "react";
import { Keyboard, Text as NativeText, Pressable, TextInput, View } from "react-native";
import { DictationKey, DictationNotice, DictationPill } from "../dictation/DictationControls";
import { useComposerDictation } from "../dictation/use-composer-dictation";
import { Plus } from "../generated/icons";
import { cn } from "../ui/cn";
import { fonts } from "../generated/tokens";
import { ComposerChips } from "./ComposerChips";
import { ComposerImages } from "./ComposerImages";
import type { Draft } from "./drafts";
import { tagRuns, tagWordAt, type DraftTag } from "./note-draft";
import { PeoplePicker } from "./PeoplePicker";
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
  /** Images cannot be sent here: the button stays, faint, and a tap says why. */
  attachDimmed?: boolean;
  /** Model and mode in the bar; an Orcling's chat leaves them to the Orcling, as texting has no such controls. */
  chips?: boolean;
  /** The bar's end: activity, then the actions, the ink pill last. */
  children: ReactNode;
  /** In a cloud thread where the reader may post notes: `@` offers its people, and a pick tags one in the draft. */
  tagging?: Tagging | null;
}

/** Tagging people in a draft: the thread whose people `@` offers, the reader it leaves out, and a pick's tag. */
export interface Tagging {
  threadId: string;
  viewerId: string | null;
  /** Writes the person's tag in place of the `@` word, and says where the caret goes after it. */
  onPick: (person: DraftTag, word: { start: number }, caret: number) => number;
}

/** The prompt's own runs, so a skill in the Bold face moves nothing out from under the caret, and a tagged person reads as one. */
function promptRuns(segments: readonly { text: string; skill?: unknown }[], tags: readonly DraftTag[]) {
  return segments.map((segment, index) =>
    segment.skill ? (
      <NativeText key={index} className="text-mention-ink" style={{ fontFamily: fonts.bold }}>
        {segment.text}
      </NativeText>
    ) : (
      <NativeText key={index}>
        {tagRuns(segment.text, tags).map((run, at) =>
          run.tag ? (
            <NativeText key={at} className="text-mention-ink">
              {run.text}
            </NativeText>
          ) : (
            run.text
          ),
        )}
      </NativeText>
    ),
  );
}

/**
 * The composer's one r20 plane, for a thread and for a new one: the draft's images, the prompt, and a bar with attach,
 * model and mode on the left and the actions on the right. While the prompt has the keyboard, a `/` word opens the
 * skill picker in a piece above it.
 */
export function ComposerPlane({
  composerId,
  skillScope,
  settings,
  draft,
  uploading,
  placeholder,
  autoFocus,
  onFocusChange,
  onText,
  onRemoveImage,
  onAttach,
  attachDimmed = false,
  chips = true,
  children,
  tagging = null,
}: ComposerPlaneProps) {
  const [focused, setFocused] = useState(Boolean(autoFocus));
  const picker = useSkillPicker({ scope: skillScope, agent: settings.choice?.agent, claudeAccountId: settings.claudeAccount?.chosen ?? settings.claudeAccountId, text: draft.text, onText });
  const word = tagging ? tagWordAt(draft.text, picker.caret) : null;
  const dictation = useComposerDictation({ owner: composerId, text: draft.text, onText, onCaret: picker.place });
  return (
    <>
      {focused && tagging && word ? (
        <PeoplePicker
          threadId={tagging.threadId}
          viewerId={tagging.viewerId}
          query={word.query}
          onPick={(person) => picker.place(tagging.onPick({ id: person.id, name: person.name }, word, picker.caret))}
        />
      ) : null}
      {focused && !word ? <SkillPicker matches={picker.matches} notice={picker.notice} onPick={picker.pick} /> : null}
      <View className="gap-3.5 rounded-3xl bg-composer-input pb-3 pl-4 pr-3 pt-3.5">
        <ComposerImages images={draft.images} uploading={uploading} onRemove={onRemoveImage} />
        <TextInput
          ref={dictation.input}
          multiline
          autoFocus={autoFocus}
          // Spoken into, the draft takes no typing: the words would land in two places at once.
          editable={!dictation.phase}
          onChangeText={onText}
          selection={picker.selection}
          onSelectionChange={(event) => {
            dictation.onSelection(event.nativeEvent.selection);
            picker.onSelectionChange(event.nativeEvent.selection.end);
          }}
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
          {promptRuns(picker.segments, draft.tags ?? [])}
        </TextInput>
        {dictation.notice ? <DictationNotice kind={dictation.notice} /> : null}
        <View className="flex-row items-center justify-between gap-2">
          {dictation.phase ? <DictationPill phase={dictation.phase} since={dictation.since} onFinish={dictation.toggle} onCancel={dictation.cancel} /> : null}
          <View className={cn("min-w-0 flex-1 flex-row items-center gap-1.5", dictation.phase && "hidden")}>
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
              <Plus size={16} className={cn("text-ink-4", attachDimmed && "opacity-40")} />
            </Pressable>
            {chips ? <ComposerChips composerId={composerId} settings={settings} /> : null}
          </View>
          <View className="flex-row items-center gap-2.5">
            {dictation.phase ? null : <DictationKey onPress={dictation.toggle} />}
            {children}
          </View>
        </View>
      </View>
    </>
  );
}
