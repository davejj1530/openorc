import type { TeamChatAnswered, TeamChatPerson } from "@openorc/protocol";
import { answeredName } from "@openorc/client";
import { answeredWords } from "../lib/team-chat-replies";
import { CornerUpLeft, X } from "./icons";
import { Tooltip } from "./ui";

/** The message a reply answers, above the reply's bubble; pressing it shows that message in place. */
export function TeamChatReplyQuote({ answered, self, people, onOpen }: { answered: TeamChatAnswered; self: string; people: readonly TeamChatPerson[]; onOpen?: () => void }) {
  const name = answeredName(answered, self);
  const words = answeredWords(answered, people);
  return (
    <button type="button" className="team-chat-reply-quote" onClick={onOpen} disabled={!onOpen} aria-label={`Show the message from ${name}: ${words}`}>
      <CornerUpLeft size={12} />
      <span className="team-chat-reply-name">{name}</span>
      <span className="team-chat-reply-words">{words}</span>
    </button>
  );
}

export interface TeamChatReplying {
  answered: TeamChatAnswered;
  self: string;
  people: readonly TeamChatPerson[];
  onCancel(): void;
}

/** The composer's line naming the message the next send answers, with the way to answer none. */
export function TeamChatReplyingLine({ answered, self, people, onCancel }: TeamChatReplying) {
  const name = answeredName(answered, self);
  return (
    <div className="team-chat-replying">
      <CornerUpLeft size={14} />
      <span className="team-chat-replying-text">
        Replying to <strong>{name === "You" ? "yourself" : name}</strong> {answeredWords(answered, people)}
      </span>
      <Tooltip label="Cancel reply">
        <button type="button" aria-label="Cancel reply" onClick={onCancel}>
          <X size={14} />
        </button>
      </Tooltip>
    </div>
  );
}
