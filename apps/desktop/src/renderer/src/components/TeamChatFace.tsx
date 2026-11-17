import type { TeamChatPerson, TeamConversation } from "@openorc/protocol";
import { AccountFace } from "./AccountFace";
import { Hash, Lock } from "./icons";
import { cn } from "../lib/cn";
import { useTeamChatPresence } from "../lib/team-chat-presence";
import "../styles/team-chat-presence.css";

/** Faces of people, each with a filled dot while one of their OpenOrc apps is connected; nothing when it isn't or isn't known. */
export function TeamChatFace({ people, max = 2, className }: { people: readonly TeamChatPerson[]; max?: number; className?: string }) {
  const presence = useTeamChatPresence();
  return (
    <span className={cn("team-chat-faces", className)}>
      {people.slice(0, max).map((person) => (
        <span key={person.id} className="team-chat-face">
          <AccountFace name={person.name} image={person.image} />
          {presence.get(person.id) === "connected" ? <span className="team-chat-presence" role="img" aria-label="Connected to OpenOrc" data-tip="Connected to OpenOrc" /> : null}
        </span>
      ))}
    </span>
  );
}
export function TeamConversationFace({ conversation, self, className }: { conversation: TeamConversation; self: string; className?: string }) {
  if (conversation.kind === "channel") {
    const Icon = conversation.private ? Lock : Hash;
    return <Icon size={18} className={className} />;
  }
  const others = (conversation.participants ?? []).flatMap(({ person }) => (person.id === self ? [] : [person]));
  return <TeamChatFace people={others} className={cn(others.length > 1 && "team-chat-pair", className)} />;
}
