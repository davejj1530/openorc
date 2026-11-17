import type { ThreadTaggable } from "@openorc/protocol";
import { keepPreviousData } from "@tanstack/react-query";
import { Pressable, ScrollView, View } from "react-native";
import { useRpc } from "../client";
import { haptic } from "../ui/haptics";
import { PersonFace } from "../ui/PersonFace";
import { Text } from "../ui/Text";

/** Four rows and half of the next, so a longer list shows it scrolls. */
const LIST_MAX = 44 * 4.5 + 12;

/**
 * The people of a cloud thread whose names answer the `@` word being typed, as its server finds them, never the reader:
 * in a piece of its own above the composer, as the skills are, each by face and full name. People who share a name
 * carry their address, which tells them apart. The list stands while the next word's read is on its way.
 */
export function PeoplePicker({ threadId, viewerId, query, onPick }: { threadId: string; viewerId: string | null; query: string; onPick: (person: ThreadTaggable) => void }) {
  const read = useRpc("threads.people", { threadId, ...(query && { q: query }) }, { staleTime: 10_000, placeholderData: keepPreviousData });
  const people = (read.data?.people ?? []).filter((person) => person.id !== viewerId);
  if (!people.length) return null;
  return (
    <View className="overflow-hidden rounded-3xl bg-composer-input">
      <ScrollView keyboardShouldPersistTaps="always" scrollsToTop={false} style={{ maxHeight: LIST_MAX }} contentContainerClassName="p-1.5">
        {people.map((person) => (
          <Pressable
            key={person.id}
            accessibilityRole="button"
            accessibilityLabel={person.address ? `${person.name}, ${person.address}` : person.name}
            onPress={() => {
              haptic.select();
              onPick(person);
            }}
            className="min-h-11 flex-row items-center gap-3 rounded-2xl px-3 active:bg-surface-2"
          >
            <PersonFace name={person.name} image={person.image} size="md" />
            <Text numberOfLines={1} className="shrink text-sm text-ink">
              {person.name}
            </Text>
            {person.address ? (
              <Text numberOfLines={1} className="flex-1 text-sm text-ink-3">
                {person.address}
              </Text>
            ) : null}
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}
