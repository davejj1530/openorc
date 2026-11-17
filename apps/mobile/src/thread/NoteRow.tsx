import { noteSegments, personName } from "@openorc/client";
import type { ThreadNote } from "@openorc/protocol";
import { memo } from "react";
import { View } from "react-native";
import { PersonFace } from "../ui/PersonFace";
import { Text } from "../ui/Text";

/**
 * A note in a cloud thread, as the desktop draws one: its own filled block with its author's face and name and the word
 * Note, never the agent's mark or a turn's status, and its words with the people it tags in the mention ink.
 */
export const NoteRow = memo(function NoteRow({ note }: { note: ThreadNote }) {
  const name = personName(note.author);
  return (
    <View accessibilityLabel={`Note from ${name}`} className="gap-2 rounded-2xl bg-bubble px-4 py-3.5">
      <View className="flex-row items-center gap-2">
        {note.author ? <PersonFace name={name} image={note.author.image} size="md" /> : null}
        <Text numberOfLines={1} className="shrink text-sm text-bubble-ink">
          {name}
        </Text>
        <Text className="text-sm text-ink-4">Note</Text>
      </View>
      <Text prose selectable className="text-md text-bubble-ink">
        {noteSegments(note).map((run, index) =>
          run.tag ? (
            <Text key={index} className="text-mention-ink">
              {run.text}
            </Text>
          ) : (
            run.text
          ),
        )}
      </Text>
    </View>
  );
});
