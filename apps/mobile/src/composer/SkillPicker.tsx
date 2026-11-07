import type { SkillCommand, SkillListNotice } from "@openorc/client";
import { Pressable, ScrollView, View } from "react-native";
import { haptic } from "../ui/haptics";
import { Text } from "../ui/Text";

/** Four rows and half of the next, so a longer list shows it scrolls. */
const LIST_MAX = 44 * 4.5 + 12;

/**
 * The skills that answer the `/` or `$` word being typed, in a piece of its own above the composer: a tap puts one in
 * the message. While there are none to offer yet it says why instead, the reason under it, since a phone has no hover.
 */
export function SkillPicker({ matches, notice, onPick }: { matches: SkillCommand[]; notice: SkillListNotice | null; onPick: (skill: SkillCommand) => void }) {
  if (matches.length === 0 && !notice) return null;
  return (
    <View className="overflow-hidden rounded-3xl bg-composer-input">
      <ScrollView keyboardShouldPersistTaps="always" scrollsToTop={false} style={{ maxHeight: LIST_MAX }} contentContainerClassName="p-1.5">
        {matches.map((skill) => (
          <Pressable
            key={`${skill.prefix}${skill.name}`}
            accessibilityRole="button"
            accessibilityLabel={`${skill.prefix}${skill.name}`}
            accessibilityHint={skill.hint}
            onPress={() => {
              haptic.select();
              onPick(skill);
            }}
            className="min-h-11 flex-row items-center gap-3 rounded-2xl px-3 active:bg-surface-2"
          >
            <Text numberOfLines={1} className="max-w-[55%] flex-shrink-0 font-mono text-sm text-ink">
              {skill.prefix}
              {skill.name}
            </Text>
            <Text numberOfLines={1} className="flex-1 text-sm text-ink-3">
              {skill.hint}
            </Text>
          </Pressable>
        ))}
        {notice ? (
          <View accessibilityRole="text" className="min-h-11 justify-center gap-0.5 px-3 py-2.5">
            <Text className="text-sm text-ink-3">{notice.text}</Text>
            {notice.reason ? <Text className="text-sm text-ink-4">{notice.reason}</Text> : null}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}
