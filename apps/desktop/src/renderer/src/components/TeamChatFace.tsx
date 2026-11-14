import type { TeamChatPerson, TeamConversation } from "@openorc/protocol";
import { AccountFace } from "./AccountFace";
import { Hash, Lock } from "./icons";
import { cn } from "../lib/cn";

export function TeamChatFace({ people, className }: { people: readonly TeamChatPerson[]; className?: string }) {
  return (
    <span className={cn("team-chat-faces", className)}>
      {people.slice(0, 2).map((person) => (
        <AccountFace key={person.id} name={person.name} image={person.image} />
      ))}
    </span>
  );
}
export function TeamConversationFace({ conversation, self, className }: { conversation: TeamConversation; self: string; className?: string }) {
  if (conversation.kind === "channel") {
    const Icon = conversation.private ? Lock : Hash;
    return <Icon size={18} className={className} />;
  }
  return <TeamChatFace people={(conversation.participants ?? []).flatMap(({ person }) => (person.id === self ? [] : [person]))} className={className} />;
}
