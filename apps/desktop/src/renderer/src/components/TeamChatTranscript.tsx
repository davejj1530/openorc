import { useEffect, useLayoutEffect, useRef } from "react";
import { stretchTime } from "@openorc/client";
import type { PendingTeamMessage, TeamChatPerson, TeamChatReaction, TeamMessage } from "@openorc/protocol";
import { cn } from "../lib/cn";
import { teamChatGroups } from "../lib/team-chat-groups";
import { useTeamChatVisible } from "../lib/team-chat-visibility";
import { lastDisplayed, useWindowAttention } from "../lib/team-chat-seen";
import { AccountFace } from "./AccountFace";
import { TeamChatMessage } from "./TeamChatMessage";
import { Tooltip } from "./ui";
import "../styles/team-chat-unread.css";

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
  /** Messages after this sequence from other people sit below New messages; null draws no line. */
  newFrom?: number | null;
  /** The latest message this window shows while focused and visible. */
  onShown?: (message: TeamMessage) => void;
}
export function TeamChatTranscript(props: TeamChatTranscriptProps) {
  const visible = useTeamChatVisible();
  const viewport = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const previous = useRef({ height: 0, first: "" });
  const attending = useWindowAttention();
  const placed = useRef(false);
  const firstNew = props.newFrom == null ? undefined : props.messages.find((message) => message.seq > props.newFrom! && message.actor.person?.id !== props.self);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || !visible) return;
    const line = !placed.current && firstNew ? element.querySelector<HTMLElement>(".team-chat-new") : null;
    if (line) {
      // An unread conversation opens at its reading place, the line near the top, not at its latest message.
      placed.current = true;
      element.scrollTop = Math.max(0, element.scrollTop + line.getBoundingClientRect().top - element.getBoundingClientRect().top - 48);
      pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    } else if (pinned.current) element.scrollTop = element.scrollHeight;
    else if (previous.current.first !== props.messages[0]?.id) element.scrollTop += element.scrollHeight - previous.current.height;
    previous.current = { height: element.scrollHeight, first: props.messages[0]?.id ?? "" };
  }, [visible, props.messages, props.pending, firstNew]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || !visible || typeof ResizeObserver === "undefined") return;
    const resize = new ResizeObserver(() => {
      if (pinned.current) element.scrollTop = element.scrollHeight;
      previous.current.height = element.scrollHeight;
    });
    resize.observe(element);
    if (element.firstElementChild) resize.observe(element.firstElementChild);
    return () => resize.disconnect();
  }, [visible]);
  const { onShown, messages } = props;
  useEffect(() => {
    const element = viewport.current;
    if (!element || !visible || !attending || !onShown) return;
    const report = () => {
      const box = element.getBoundingClientRect();
      const rows = new Map([...element.querySelectorAll<HTMLElement>("[data-message-id]")].map((row) => [row.dataset["messageId"], row]));
      const shown = lastDisplayed(messages, box, (id) => rows.get(id)?.querySelector(".orcling-bubble")?.getBoundingClientRect().bottom ?? null);
      if (shown) onShown(shown);
    };
    report();
    element.addEventListener("scroll", report, { passive: true });
    const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(report);
    resized?.observe(element);
    return () => {
      element.removeEventListener("scroll", report);
      resized?.disconnect();
    };
  }, [visible, attending, onShown, messages]);
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
        {groups.flatMap((group) => {
          if (group.kind === "time")
            return [
              <div key={group.id} className="orcling-chat-time">
                {stretchTime(group.at)}
              </div>,
            ];
          const split = firstNew ? group.messages.findIndex((message) => message.id === firstNew.id) : -1;
          if (split < 0) return [<SpeakerGroup key={group.id} {...props} messages={group.messages} />];
          return [
            ...(split > 0 ? [<SpeakerGroup key={group.id} {...props} messages={group.messages.slice(0, split)} />] : []),
            <div key="new" className="team-chat-new" role="separator">
              <span>New messages</span>
            </div>,
            <SpeakerGroup key={`${group.id}:new`} {...props} messages={group.messages.slice(split)} />,
          ];
        })}
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
        {message.body.trim() ? <div className="message-bubble whitespace-pre-wrap">{message.body}</div> : null}
        {message.files.length ? <div className="team-chat-pending-files">{message.files.map((file) => file.name).join(", ")}</div> : null}
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
