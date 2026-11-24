import { answeredName, type TeamChatTarget } from "@openorc/client";
import type { TeamChatOrclingPick } from "@openorc/protocol";
import { useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { teamChat } from "../client";
import { tagWordAt } from "../composer/note-draft";
import { SendButton } from "../composer/SendButton";
import { OrclingFace } from "../orclings/OrclingFace";
import { haptic } from "../ui/haptics";
import { Measure } from "../ui/pane";
import { Text } from "../ui/Text";

/** Four rows and half of the next, so a longer list shows it scrolls. */
const LIST_MAX = 44 * 4.5 + 12;

/** The reader's own Orclings whose names answer the `@` word being typed, above the composer, each by its face and name. */
function OrclingPicker({ picks, onPick }: { picks: readonly TeamChatOrclingPick[]; onPick: (pick: TeamChatOrclingPick) => void }) {
  return (
    <View className="overflow-hidden rounded-3xl bg-composer-input">
      <ScrollView keyboardShouldPersistTaps="always" scrollsToTop={false} style={{ maxHeight: LIST_MAX }} contentContainerClassName="p-1.5">
        {picks.map((pick) => (
          <Pressable
            key={pick.localOrclingId}
            accessibilityRole="button"
            accessibilityLabel={`Call ${pick.name}`}
            onPress={() => {
              haptic.select();
              onPick(pick);
            }}
            className="min-h-11 flex-row items-center gap-3 rounded-2xl px-3 active:bg-surface-2"
          >
            <OrclingFace look={pick.look} size={20} />
            <Text numberOfLines={1} className="shrink text-sm text-ink">
              {pick.name}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

/**
 * The composer under a conversation: what the draft answers, why the last move failed, and the words, kept per
 * conversation. Where the organization's chat takes Orclings, an `@` word offers the reader's own, which the message
 * then calls while its name stays in the words.
 */
export function ChatComposer({
  target,
  title,
  failure,
  self,
  orclings,
  onSend,
  onFocus,
}: {
  target: TeamChatTarget;
  title: string;
  failure: string | null;
  self: string;
  orclings: boolean;
  onSend: () => void;
  onFocus: () => void;
}) {
  const insets = useSafeAreaInsets();
  const draft = teamChat.useDraft(target);
  // The caret, at the end of the words until the field says where it is.
  const [selected, setCaret] = useState<number | null>(null);
  const caret = selected ?? draft.text.length;
  const word = orclings ? tagWordAt(draft.text, caret) : null;
  const picks = teamChat.useOrclingPicks(word !== null).filter((pick) => word && pick.name.toLowerCase().startsWith(word.query.toLowerCase()));
  const pick = (orcling: TeamChatOrclingPick) => {
    if (!word) return;
    const tag = `@${orcling.name} `;
    teamChat.drafts.write(target, `${draft.text.slice(0, word.start)}${tag}${draft.text.slice(caret)}`);
    teamChat.drafts.callOrcling(target, orcling);
    setCaret(word.start + tag.length);
  };
  return (
    <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }}>
      <View className="bg-bg pt-2" style={{ paddingBottom: insets.bottom + 8 }}>
        <Measure className="gap-2 px-3">
          {failure ? <Text className="px-2 text-sm text-bad">{failure}</Text> : null}
          {draft.replyTo ? (
            <View className="flex-row items-center gap-2 px-2">
              <Text numberOfLines={1} className="min-w-0 flex-1 text-sm text-ink-3">
                {`Replying to ${answeredName(draft.replyTo, self)}: ${draft.replyTo.excerpt}`}
              </Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Don't reply" onPress={() => teamChat.drafts.reply(target, null)} hitSlop={8} className="active:opacity-60">
                <Text className="text-sm text-ink-2">Cancel</Text>
              </Pressable>
            </View>
          ) : null}
          {picks.length ? <OrclingPicker picks={picks} onPick={pick} /> : null}
          <View className="flex-row items-end gap-2 rounded-3xl bg-composer-input py-2 pl-4 pr-2">
            <TextInput
              multiline
              value={draft.text}
              onChangeText={(text) => teamChat.drafts.write(target, text)}
              onSelectionChange={({ nativeEvent }) => setCaret(nativeEvent.selection.end)}
              onFocus={onFocus}
              placeholder={`Message ${title}…`}
              accessibilityLabel="Message"
              className="min-h-touch flex-1 py-2.5 font-sans text-md leading-5 text-ink"
              placeholderTextColorClassName="accent-ink-4"
              style={{ maxHeight: 120 }}
            />
            <SendButton state="send" disabled={!draft.text.trim()} onPress={onSend} />
          </View>
        </Measure>
      </View>
    </KeyboardStickyView>
  );
}
