import type { TeamConversation } from "@openorc/protocol";
import { teamConversationTitle } from "@openorc/client";
import { TopBar } from "./TopBar";
import { ThreadTabs } from "./ThreadTabs";
import { TeamChatFace, TeamConversationFace } from "./TeamChatFace";
import { TeamChatComposer } from "./TeamChatComposer";
import { TeamChatTranscript, type TeamChatTranscriptProps } from "./TeamChatTranscript";
import { Loader2, X } from "./icons";
import { Button } from "./ui";
import "../styles/team-chat.css";

export interface TeamChatProps extends TeamChatTranscriptProps {
  conversation: TeamConversation;
  draft: string;
  onDraft(text: string): void;
  onSend(): void;
  error: string | null;
  loading: boolean;
  onReload(): void;
  notice?: { message: string; dismiss(): void };
}
export function TeamChat(props: TeamChatProps) {
  const title = teamConversationTitle(props.conversation, props.self);
  const placeholder = props.conversation.kind === "channel" ? `Message #${title}…` : `Message ${title}…`;
  return (
    <main className="well flex-1 min-w-0 flex flex-col team-chat">
      <TopBar tabs>
        <ThreadTabs />
      </TopBar>
      <header className="team-chat-heading">
        <div className="team-chat-heading-name">
          <TeamConversationFace conversation={props.conversation} self={props.self} />
          <span>{title}</span>
        </div>
        {props.conversation.kind === "channel" ? (
          <div className="team-chat-heading-people">
            <TeamChatFace people={props.conversation.members} max={3} />
            <span>{props.conversation.members.length}</span>
          </div>
        ) : null}
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
      {!props.loading && !props.error ? <TeamChatComposer text={props.draft} placeholder={placeholder} reason={props.reason} onChange={props.onDraft} onSend={props.onSend} /> : null}
    </main>
  );
}

function TeamChatBody(props: TeamChatProps) {
  if (props.loading)
    return (
      <div className="team-chat-state" role="status">
        <Loader2 size={16} className="animate-spin" />
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
  return <TeamChatTranscript {...props} />;
}
