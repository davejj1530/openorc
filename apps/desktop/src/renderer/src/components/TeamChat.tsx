import type { TeamChatAnswered, TeamChatFile, TeamChatOrclingPick, TeamConversation } from "@openorc/protocol";
import { WorkingMark } from "./StateMark";
import type { ReactNode } from "react";
import { teamChatShortNames, teamConversationTitle } from "@openorc/client";
import { TopBar } from "./TopBar";
import { ThreadTabs } from "./ThreadTabs";
import { TeamChatFace, TeamConversationFace } from "./TeamChatFace";
import { TeamChatComposer, type TeamChatComposerFiles } from "./TeamChatComposer";
import { TeamChatTranscript, type TeamChatTranscriptProps } from "./TeamChatTranscript";
import { ChevronDown, X } from "./icons";
import { Button } from "./ui";
import "../styles/team-chat.css";

export interface TeamChatProps extends Omit<TeamChatTranscriptProps, "conversationId"> {
  conversation: TeamConversation;
  draft: string;
  onDraft(text: string): void;
  onSend(files: TeamChatFile[]): void;
  error: string | null;
  loading: boolean;
  onReload(): void;
  notice?: { message: string; dismiss(): void };
  footer?: ReactNode;
  onDetails?: () => void;
  /** Whether people can be tagged here, which the server's unread capability brings. */
  tags?: boolean;
  /** Where this conversation's files go, when the server's files capability is on and the person has joined. */
  files?: TeamChatComposerFiles | null;
  /** The message the next send answers, and the way to answer none. */
  replyTo?: TeamChatAnswered | null;
  onCancelReply?: () => void;
  /** The heading's pins, where the server keeps them. */
  pins?: ReactNode;
  /** The person's own Orclings the composer can call, where the server takes calls. */
  orclings?: readonly TeamChatOrclingPick[];
  onOrcling?: (orcling: TeamChatOrclingPick) => void;
}
export function TeamChat(props: TeamChatProps) {
  const title = teamConversationTitle(props.conversation, props.self);
  const placeholder = props.conversation.kind === "channel" ? `Message #${title}…` : `Message ${spokenList(teamChatShortNames(others(props.conversation, props.self)))}…`;
  const group = props.conversation.kind === "channel" || others(props.conversation, props.self).length > 1;
  return (
    <main className="well flex-1 min-w-0 flex flex-col team-chat">
      <TopBar tabs>
        <ThreadTabs />
      </TopBar>
      <header className="team-chat-heading">
        {props.onDetails ? (
          <button type="button" className="team-chat-heading-name" onClick={props.onDetails} aria-label={`Details for ${props.conversation.kind === "channel" ? "#" : ""}${title}`}>
            <TeamConversationFace conversation={props.conversation} self={props.self} />
            <span>{title}</span>
            <ChevronDown size={12} />
          </button>
        ) : (
          <div className="team-chat-heading-name">
            <TeamConversationFace conversation={props.conversation} self={props.self} />
            <span>{title}</span>
          </div>
        )}
        <div className="team-chat-heading-tools">
          {props.pins}
          {group ? (
            <div className="team-chat-heading-people">
              <TeamChatFace people={props.conversation.members} max={3} />
              <span>{props.conversation.members.length}</span>
            </div>
          ) : null}
        </div>
      </header>
      <TeamChatBody {...props} />
      {props.notice ? (
        <div className="team-chat-action-error" role="status">
          <span>{props.notice.message}</span>
          <button type="button" onClick={props.notice.dismiss} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      ) : null}
      {!props.loading && !props.error
        ? (props.footer ?? (
            <TeamChatComposer
              text={props.draft}
              placeholder={placeholder}
              reason={props.reason}
              onChange={props.onDraft}
              onSend={props.onSend}
              taggable={props.tags ? taggable(props.conversation, props.people, props.self) : []}
              named={props.tags ? props.people : []}
              files={props.files ?? null}
              replying={props.replyTo && props.onCancelReply ? { answered: props.replyTo, self: props.self, people: props.people, onCancel: props.onCancelReply } : null}
              orclings={props.orclings}
              onOrcling={props.onOrcling}
            />
          ))
        : null}
    </main>
  );
}

/** A public channel may tag anyone in the organization; a private one, a group or a DM only the people in it. */
const taggable = (conversation: TeamConversation, people: TeamChatProps["people"], self: string) =>
  (conversation.kind === "channel" && !conversation.private ? people : conversation.members).filter((person) => person.id !== self);
const others = (conversation: TeamConversation, self: string) => (conversation.participants ?? []).flatMap(({ person }) => (person.id === self ? [] : [person]));
const spokenList = (names: readonly string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "this chat"));

function TeamChatBody(props: TeamChatProps) {
  if (props.loading)
    return (
      <div className="team-chat-state" role="status">
        <WorkingMark />
        <span>Loading chat…</span>
      </div>
    );
  if (props.error)
    return (
      <div className="team-chat-state" role="status">
        <p>{props.error}</p>
        <Button size="sm" onClick={props.onReload}>
          Try again
        </Button>
      </div>
    );
  return <TeamChatTranscript {...props} conversationId={props.conversation.id} />;
}
