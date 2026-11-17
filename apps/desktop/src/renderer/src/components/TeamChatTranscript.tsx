import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { stretchTime } from "@openorc/client";
import { actorPerson, type PendingTeamMessage, type TeamChatAnswered, type TeamChatPerson, type TeamChatReaction, type TeamMessage, type TeamOrclingCall } from "@openorc/protocol";
import { cn } from "../lib/cn";
import { teamChatGroups } from "../lib/team-chat-groups";
import { useTeamChatVisible } from "../lib/team-chat-visibility";
import { lastDisplayed, useWindowAttention } from "../lib/team-chat-seen";
import { TeamChatActorFace } from "./TeamChatActorFace";
import { actorName } from "../lib/team-chat-actor";
import { TeamChatMessage } from "./TeamChatMessage";
import { TeamChatReplyQuote } from "./TeamChatReplyQuote";
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
  /** Answering a message from the composer; absent where replies aren't available. */
  onReply?: (message: TeamMessage) => void;
  onOpenAnswered?: (answered: TeamChatAnswered) => void;
  /** Pinning for everyone; absent where pins aren't available or for a reader who hasn't joined. */
  onPin?: (message: TeamMessage, pinned: boolean) => void;
  /** The owner tries again a call of their own Orcling. */
  onRetryCall?: (call: TeamOrclingCall) => void;
  /** A message to bring into view and mark, once it is on the page. */
  reveal?: { id: string; nonce: number } | null;
  onRevealed?: (nonce: number) => void;
}
export function TeamChatTranscript(props: TeamChatTranscriptProps) {
  const visible = useTeamChatVisible();
  const viewport = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const previous = useRef({ height: 0, first: "" });
  const attending = useWindowAttention();
  const placed = useRef(false);
  const firstNew = props.newFrom == null ? undefined : props.messages.find((message) => message.seq > props.newFrom! && actorPerson(message.actor)?.id !== props.self);
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
  const found = useRevealed(viewport, visible, props.reveal ?? null, props.onRevealed, pinned);
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
          if (split < 0) return [<SpeakerGroup key={group.id} {...props} found={found} messages={group.messages} />];
          return [
            ...(split > 0 ? [<SpeakerGroup key={group.id} {...props} found={found} messages={group.messages.slice(0, split)} />] : []),
            <div key="new" className="team-chat-new" role="separator">
              <span>New messages</span>
            </div>,
            <SpeakerGroup key={`${group.id}:new`} {...props} found={found} messages={group.messages.slice(split)} />,
          ];
        })}
        {props.pending
          .filter((message) => !sent.has(message.id))
          .map((message) => (
            <PendingBubble key={message.id} message={message} self={props.self} people={props.people} reason={props.reason} onRetry={() => props.onRetry(message)} />
          ))}
      </div>
    </div>
  );
}
function SpeakerGroup({
  messages,
  self,
  people,
  reason,
  names,
  onReact,
  onReply,
  onOpenAnswered,
  onPin,
  onRetryCall,
  found,
}: Pick<TeamChatTranscriptProps, "messages" | "self" | "people" | "reason" | "names" | "onReact" | "onReply" | "onOpenAnswered" | "onPin" | "onRetryCall"> & { found: string | null }) {
  const actor = messages[0]!.actor;
  const mine = actorPerson(actor)?.id === self;
  const orcling = actor.kind === "orcling" ? actor : null;
  return (
    <div
      className={cn("orcling-run team-chat-run", mine && "team-chat-run-mine", orcling && "team-chat-run-orcling")}
      {...(orcling && { style: { "--orcling-tint": orcling.look.bodyColor } as CSSProperties })}
    >
      {!mine ? <TeamChatActorFace actor={actor} size={28} className="orcling-run-face" /> : null}
      {orcling ? <div className="orcling-run-name">{`${orcling.name} · ${orcling.owner.id === self ? "Your" : `${orcling.owner.name}'s`} Orcling`}</div> : null}
      {!mine && !orcling && names ? <div className="orcling-run-name">{actorName(actor)}</div> : null}
      <div className="orcling-run-bubbles">
        {messages.map((message) => (
          <TeamChatMessage
            key={message.id}
            message={message}
            self={self}
            people={people}
            reason={reason}
            onReact={(emoji) => onReact(message, emoji)}
            {...(onReply && { onReply: () => onReply(message) })}
            {...(onOpenAnswered && message.replyTo && { onOpenAnswered: () => onOpenAnswered(message.replyTo!) })}
            {...(onPin && { onPin: (pinned: boolean) => onPin(message, pinned) })}
            onRetryCall={onRetryCall}
            found={found === message.id || undefined}
          />
        ))}
      </div>
    </div>
  );
}
function PendingBubble({ message, self, people, reason, onRetry }: { message: PendingTeamMessage; self: string; people: readonly TeamChatPerson[]; reason: string | null; onRetry(): void }) {
  return (
    <div className="team-chat-pending journal-prompt">
      {message.replyTo ? <TeamChatReplyQuote answered={message.replyTo} self={self} people={people} /> : null}
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

/** Brings a requested message into view once it is drawn and marks it for a moment; the mark is its id. */
function useRevealed(
  viewport: RefObject<HTMLDivElement | null>,
  visible: boolean,
  reveal: { id: string; nonce: number } | null,
  onRevealed: ((nonce: number) => void) | undefined,
  pinned: RefObject<boolean>,
) {
  const [found, setFound] = useState<{ id: string; nonce: number } | null>(null);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!reveal || !element || !visible) return;
    const row = [...element.querySelectorAll<HTMLElement>("[data-message-id]")].find((candidate) => candidate.dataset["messageId"] === reveal.id);
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    setFound(reveal);
    onRevealed?.(reveal.nonce);
  }, [viewport, visible, reveal, onRevealed, pinned]);
  useEffect(() => {
    if (!found) return;
    const fade = setTimeout(() => setFound(null), 1600);
    return () => clearTimeout(fade);
  }, [found]);
  return found?.id ?? null;
}
