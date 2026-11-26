import { useEffect, useMemo, useRef, useState } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { actorPerson, type TeamChatPerson, type TeamChatReaction, type TeamMessage, type TeamOrclingCall } from "@openorc/protocol";
import { TeamChatCallLine } from "./TeamChatCallLine";
import { actorName } from "../lib/team-chat-actor";
import { cn } from "../lib/cn";
import { useTeamChatVisible } from "../lib/team-chat-visibility";
import { CoversPreview } from "../lib/browser-preview";
import { floatingGround } from "../lib/use-anchor-ground";
import { menuPopup } from "./menu";
import { TeamChatMessageActions, TeamChatMessageMenuItems, TeamChatPinnedMark } from "./TeamChatMessageControls";
import { TeamChatFiles } from "./TeamChatFiles";
import { TeamChatReactionPicker, TeamChatReactions } from "./TeamChatReactions";
import { TeamChatReplyQuote } from "./TeamChatReplyQuote";
import { defaultRehypePlugins } from "streamdown";
import { holdPersonTags, personTagText, rehypePersonTags } from "../lib/rehype-person-tags";
import { RichText } from "./RichText";
import { Tooltip } from "./ui";
import { ThreadRichText, threadMarkdownComponents, threadUrlTransform } from "./ThreadImages";
import "../styles/team-chat-replies.css";

/** Where a send the server has not confirmed stands, and the way to try it again. */
export interface TeamChatSending {
  state: "sending" | "failed";
  error: string | null;
  onRetry(): void;
}

export function TeamChatMessage({
  message,
  self,
  people,
  reason,
  onReact,
  onReply,
  onOpenAnswered,
  onPin,
  onRetryCall,
  found,
  sending,
}: {
  message: TeamMessage;
  self: string;
  people: readonly TeamChatPerson[];
  reason: string | null;
  /** Reacting to it; absent while it is still being sent. */
  onReact?: (emoji: TeamChatReaction) => void;
  /** Answering this message from the composer; absent where replies aren't available. */
  onReply?: () => void;
  onOpenAnswered?: () => void;
  /** Pinning or unpinning for everyone in the conversation; absent where pins aren't available or for a reader who hasn't joined. */
  onPin?: (pinned: boolean) => void;
  /** The owner tries again a call of their Orcling this message made. */
  onRetryCall?: (call: TeamOrclingCall) => void;
  /** Shown in place just now, from a reply, a pin or a search. */
  found?: true;
  /** The person's own message the server has not confirmed: drawn as sent, with nothing to do to it until it is. */
  sending?: TeamChatSending;
}) {
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const visible = useTeamChatVisible();
  const [copyError, setCopyError] = useState(false);
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!visible) {
      setOpen(false);
      setMenuOpen(false);
    }
  }, [visible]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !row.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const mine = actorPerson(message.actor)?.id === self;
  const words = personTagText(message.body, (id) => people.find((person) => person.id === id)?.name);
  // Words keep their bubble and the files go under it; files alone sit in the bubble, which carries reactions.
  const withFiles = message.files.length > 0 && Boolean(message.body.trim());
  const copy = () => {
    void navigator.clipboard.writeText(words).then(
      () => setCopyError(false),
      () => setCopyError(true),
    );
  };
  return (
    <div
      ref={row}
      className={cn("orcling-bubble-row team-chat-message", mine && "team-chat-message-mine", withFiles && "team-chat-message-files", message.replyTo && "team-chat-message-reply")}
      data-open={(open && !reason && !sending) || undefined}
      data-found={found}
      data-sending={sending?.state}
      data-message-id={message.id}
    >
      {message.replyTo ? <TeamChatReplyQuote answered={message.replyTo} self={self} people={people} onOpen={onOpenAnswered} /> : null}
      <BubbleLine
        message={message}
        mine={mine}
        words={words}
        self={self}
        people={people}
        reason={reason}
        menu={{ open: menuOpen && visible && !sending, onOpenChange: setMenuOpen }}
        picker={{ open, onOpen: setOpen }}
        onCopy={copy}
        onReact={onReact}
        onReply={onReply}
        onPin={onPin}
      />
      {withFiles ? <TeamChatFiles files={message.files} conversationId={message.channelId} /> : null}
      <TeamChatCallLine call={message.call} self={self} onRetry={onRetryCall} />
      {sending ? <SendState sending={sending} reason={reason} /> : null}
      {copyError ? (
        <span role="status" className="team-chat-message-error">
          Text could not be copied.
        </span>
      ) : null}
    </div>
  );
}

/**
 * The bubble with its menu, pin mark and reactions. With no `onReact` it is a send the server has not confirmed, which
 * takes nothing yet.
 */
function BubbleLine({
  message,
  mine,
  words,
  self,
  people,
  reason,
  menu,
  picker,
  onCopy,
  onReact,
  onReply,
  onPin,
}: {
  message: TeamMessage;
  mine: boolean;
  words: string;
  self: string;
  people: readonly TeamChatPerson[];
  reason: string | null;
  menu: { open: boolean; onOpenChange(open: boolean): void };
  picker: { open: boolean; onOpen(open: boolean): void };
  onCopy(): void;
  onReact: ((emoji: TeamChatReaction) => void) | undefined;
  onReply: (() => void) | undefined;
  onPin: ((pinned: boolean) => void) | undefined;
}) {
  return (
    <div className="team-chat-bubble-line">
      <ContextMenu.Root open={menu.open} onOpenChange={menu.onOpenChange} disabled={!onReact}>
        <ContextMenu.Trigger className={cn("orcling-bubble", mine && "message-bubble")} tabIndex={0} aria-label={`${actorName(message.actor)}: ${words}`}>
          <BubbleContent message={message} people={people} words={words} />
          {onReact ? <TeamChatReactions reactions={message.reactions} people={people} self={self} onReact={onReact} reason={reason} side={mine ? "start" : "end"} /> : null}
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <CoversPreview />
          <ContextMenu.Positioner collisionPadding={8} className="z-40">
            <ContextMenu.Popup ref={floatingGround} className={menuPopup}>
              <TeamChatMessageMenuItems reason={reason} onReply={onReply} onCopy={onCopy} onReact={() => picker.onOpen(true)} pinned={Boolean(message.pinned)} onPin={onPin} />
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      <TeamChatPinnedMark pinned={message.pinned} />
      {onReact ? (
        <>
          <TeamChatMessageActions reason={reason} onReply={onReply} reacting={picker.open} onReacting={picker.onOpen} />
          <TeamChatReactionPicker open={picker.open && !reason} reactions={message.reactions} self={self} onReact={onReact} onClose={() => picker.onOpen(false)} />
        </>
      ) : null}
    </div>
  );
}

/** Under a send the server hasn't confirmed: Sending, said only once it is slow, or why it failed, with Retry. */
function SendState({ sending, reason }: { sending: TeamChatSending; reason: string | null }) {
  if (sending.state === "sending")
    return (
      <span className="team-chat-sending" role="status">
        Sending…
      </span>
    );
  return (
    <div className="team-chat-send-error" role="status">
      <Tooltip label={sending.error ?? "Delivery couldn't be confirmed."}>
        <span>Message not sent</span>
      </Tooltip>
      <Tooltip label={reason ?? "Retry"}>
        <button type="button" disabled={Boolean(reason)} onClick={sending.onRetry}>
          Retry
        </button>
      </Tooltip>
    </div>
  );
}

/** A message that tags people: the same Markdown, with each tag drawn as the person's name. */
function TaggedText({ body, people }: { body: string; people: readonly TeamChatPerson[] }) {
  const held = useMemo(() => holdPersonTags(body), [body]);
  const plugins = useMemo<NonNullable<Parameters<typeof RichText>[0]["rehypePlugins"]>>(
    () => [
      defaultRehypePlugins.raw!,
      ...Object.entries(defaultRehypePlugins)
        .filter(([name]) => name !== "raw")
        .map(([, plugin]) => plugin),
      [rehypePersonTags, { names: people.map((person) => [person.id, person.name] as const), ids: held.ids }],
    ],
    [people, held.ids],
  );
  return (
    <RichText mode="static" components={threadMarkdownComponents} urlTransform={threadUrlTransform} rehypePlugins={plugins}>
      {held.text}
    </RichText>
  );
}

function BubbleContent({ message, people, words }: { message: TeamMessage; people: readonly TeamChatPerson[]; words: string }) {
  if (!message.body.trim()) return <TeamChatFiles files={message.files} conversationId={message.channelId} />;
  return (
    <div className="text-prose text-ink prose-chat">{words === message.body ? <ThreadRichText mode="static">{message.body}</ThreadRichText> : <TaggedText body={message.body} people={people} />}</div>
  );
}
