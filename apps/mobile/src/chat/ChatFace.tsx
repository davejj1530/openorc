import type { TeamChatListRow } from "@openorc/client";
import type { TeamChatPerson } from "@openorc/protocol";
import { View } from "react-native";
import { PersonFace } from "../ui/PersonFace";
import { Text } from "../ui/Text";

/** Who has an OpenOrc app connected, by person id, as the chat reads it. */
export type ChatPresence = ReadonlyMap<string, string>;

/** A person's face, with a dot while one of their OpenOrc apps is connected; none when it isn't, or isn't known. */
function FaceWithPresence({ person, presence }: { person: TeamChatPerson; presence: ChatPresence }) {
  return (
    <View>
      <PersonFace name={person.name} image={person.image} size="md" />
      {presence.get(person.id) === "connected" ? (
        <View accessible accessibilityRole="image" accessibilityLabel="Connected to OpenOrc" className="absolute -bottom-1 -right-1 size-3 rounded-full border-2 border-bg bg-ok" />
      ) : null}
    </View>
  );
}

/**
 * A conversation's face in the list, as the desktop draws one: a channel's #, the other person's face with their
 * presence, or two faces for a group, which overlap, so neither carries a dot.
 */
export function ConversationFace({ row, self, presence }: { row: TeamChatListRow; self: string; presence: ChatPresence }) {
  if (row.kind === "person") return <FaceWithPresence person={row.person} presence={presence} />;
  if (row.conversation.kind === "channel") {
    return (
      <View className="size-5 items-center justify-center">
        <Text className="text-md text-ink-4">#</Text>
      </View>
    );
  }
  const others = (row.conversation.participants ?? []).flatMap(({ person }) => (person.id === self ? [] : [person]));
  const [first, second] = others;
  if (!first) return <View className="size-5" />;
  if (!second) return <FaceWithPresence person={first} presence={presence} />;
  return (
    <View className="size-5">
      <PersonFace name={first.name} image={first.image} size="sm" />
      <View className="absolute -bottom-0.5 -right-0.5 rounded-full border border-bg">
        <PersonFace name={second.name} image={second.image} size="sm" />
      </View>
    </View>
  );
}
