import { useLayoutEffect, useRef } from "react";
import { stretchTime } from "@openorc/client";
import type { PendingTeamMessage, TeamChatPerson, TeamChatReaction, TeamMessage } from "@openorc/protocol";
import { cn } from "../lib/cn";
import { teamChatGroups } from "../lib/team-chat-groups";
import { useTeamChatVisible } from "../lib/team-chat-visibility";
import { AccountFace } from "./AccountFace";
import { TeamChatMessage } from "./TeamChatMessage";
import { Tooltip } from "./ui";

export interface TeamChatTranscriptProps {
  messages: readonly TeamMessage[];
  pending: readonly PendingTeamMessage[];
  self: string;
  people: readonly TeamChatPerson[];
  names: boolean;
  reason: string | null;
  older: boolean;
  loadingOlder: boolean;
  onOlder(): void;
  onReact(message: TeamMessage, emoji: TeamChatReaction): void;
  onRetry(message: PendingTeamMessage): void;
}
export function TeamChatTranscript(props: TeamChatTranscriptProps) {
  const visible = useTeamChatVisible();
  const viewport = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const previous = useRef({ height: 0, first: "" });
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || !visible) return;
    if (pinned.current) element.scrollTop = element.scrollHeight;
    else if (previous.current.first !== props.messages[0]?.id) element.scrollTop += element.scrollHeight - previous.current.height;
    previous.current = { height: element.scrollHeight, first: props.messages[0]?.id ?? "" };
  }, [visible, props.messages, props.pending]);
  const groups = teamChatGroups(props.messages);
  const sent = new Set(props.messages.map((message) => message.id));
  return (
    <div
      ref={viewport}
      className="team-chat-scroll"
      onScroll={(event) => {
        if (!visible) return;
        const el = event.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      <div className="team-chat-transcript orcling-chat">
        {props.older ? (
          <button type="button" className="team-chat-older" disabled={props.loadingOlder} onClick={props.onOlder}>
            {props.loadingOlder ? "Loading…" : "Earlier messages"}
          </button>
        ) : null}
        {!groups.length && !props.pending.length ? <p className="team-chat-empty">No messages yet</p> : null}
        {groups.map((group) =>
          group.kind === "time" ? (
            <div key={group.id} className="orcling-chat-time">
              {stretchTime(group.at)}
            </div>
          ) : (
            <SpeakerGroup key={group.id} {...props} messages={group.messages} />
          ),
        )}
        {props.pending
          .filter((message) => !sent.has(message.id))
          .map((message) => (
            <PendingBubble key={message.id} message={message} reason={props.reason} onRetry={() => props.onRetry(message)} />
          ))}
      </div>
    </div>
  );
}
function SpeakerGroup({ messages, self, people, reason, names, onReact }: Pick<TeamChatTranscriptProps, "messages" | "self" | "people" | "reason" | "names" | "onReact">) {
  const person = messages[0]?.actor.person;
  const mine = person?.id === self;
  return (
    <div className={cn("orcling-run team-chat-run", mine && "team-chat-run-mine")}>
      {!mine ? <AccountFace name={person?.name ?? "Former member"} image={person?.image ?? null} className="orcling-run-face" /> : null}
      {!mine && names ? <div className="orcling-run-name">{person?.name ?? "Former member"}</div> : null}
      <div className="orcling-run-bubbles">
        {messages.map((message) => (
          <TeamChatMessage key={message.id} message={message} self={self} people={people} reason={reason} onReact={(emoji) => onReact(message, emoji)} />
        ))}
      </div>
    </div>
  );
}
function PendingBubble({ message, reason, onRetry }: { message: PendingTeamMessage; reason: string | null; onRetry(): void }) {
  return (
    <div className="team-chat-pending journal-prompt">
      <div className="journal-message-body">
        <div className="message-bubble whitespace-pre-wrap">{message.body}</div>
      </div>
      {message.state === "failed" ? (
        <div className="team-chat-send-error" role="status">
          <Tooltip label={message.error ?? "Delivery couldn't be confirmed."}>
            <span>Message not sent</span>
          </Tooltip>
          <Tooltip label={reason ?? "Retry"}>
            <button type="button" disabled={Boolean(reason)} onClick={onRetry}>
              Retry
            </button>
          </Tooltip>
        </div>
      ) : (
        <span className="sr-only" role="status">
          Sending
        </span>
      )}
    </div>
  );
}
