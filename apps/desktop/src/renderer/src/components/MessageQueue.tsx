import { useState } from "react";
import { failureParts, queueHint } from "@openorc/client";
import type { QueuedMessage, ThreadPerson } from "@openorc/protocol";
import { ChevronDown, X } from "./icons";
import { Button, IconButton } from "./ui";
import { useComposerControl } from "./composer-read-only";
import { QueueAuthor } from "./ThreadVoice";

/** Who wrote a queued message in a cloud thread others are in, and what the reader may do to it, as the server says. */
export interface QueuedBy {
  /** Undefined: names stay off, as in a thread nobody else is in. */
  author?: ThreadPerson | null | undefined;
  mine: boolean;
  canEdit: boolean;
  canRemove: boolean;
  /** Stopped or held by the server: no turn takes it until its author starts it as their own. */
  paused?: boolean;
  canStart?: boolean;
  /** Why its author cannot start it now, said on demand. */
  startBlocked?: string | null;
}

/**
 * Messages waiting for the turn to finish, as a pile above the composer: a front card with the
 * count and up to two cards behind it. Clicking the front fans the pile out into the messages,
 * each with Send now and Remove; pressing a message's words takes it out of the queue and back
 * into the message being written. A message that failed to send opens it on its own. In a cloud thread others are in,
 * each message names its author, and only the reader's own can go now, leave or go back (`people`).
 */
export function MessageQueue({
  messages,
  canSend,
  pending,
  sendReason,
  retryBlocked,
  agentName,
  onSend,
  onRemove,
  onEdit,
  people,
  onStart,
}: {
  messages: QueuedMessage[];
  canSend: boolean;
  pending: boolean;
  sendReason?: string | null;
  /** Why a message that failed cannot be tried again now, in the words the composer's card says it with. */
  retryBlocked?: string | null;
  /** The agent working the turn, named in the pile's hint ("Sends when Codex finishes"). */
  agentName?: string;
  onSend: (messageId: string) => void;
  onRemove: (messageId: string) => void;
  /** Takes the message out of the queue and puts its words and files back in the composer, after what is there. */
  onEdit?: ((messageId: string) => void) | undefined;
  /** Who wrote each message and the reader's rights to it; the hint names whose turn the queue waits on. */
  people?: { hint: string | null; pausedHint?: string | null; of(messageId: string): QueuedBy | null } | undefined;
  /** Starts the reader's own paused message as their own turn. */
  onStart?: ((messageId: string) => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const remove = useComposerControl(pending, "Remove from queue");
  if (!messages.length) return null;
  const open = expanded || messages.some((message) => message.error || message.interrupted);
  const behind = open ? 0 : Math.min(2, messages.length);
  const paused = messages.every((message) => people?.of(message.id)?.paused);
  return (
    <section className="message-queue" aria-label="Queued messages">
      {open ? (
        <ol className="message-queue-list motion-stagger">
          {messages.map((message, index) => {
            const by = people?.of(message.id) ?? null;
            const edit = onEdit && (!by || by.canEdit) ? () => onEdit(message.id) : undefined;
            return (
              <li className="message-queue-card motion-arrive" key={message.id}>
                <QueuedWords message={message} pending={pending} onEdit={edit} author={by?.author} />
                <div className="message-queue-actions">
                  {by?.paused && by.mine ? <QueuedStart canStart={Boolean(by.canStart)} blocked={by.startBlocked ?? null} pending={pending} onStart={() => onStart?.(message.id)} /> : null}
                  {(!by || by.mine) && !by?.paused ? <QueuedSend message={message} canSend={canSend} pending={pending} sendReason={sendReason} retryBlocked={retryBlocked} onSend={onSend} /> : null}
                  {!by || by.canRemove ? (
                    <IconButton size="xs" disabled={remove.disabled} onClick={() => onRemove(message.id)} aria-label={`Remove queued message ${index + 1}`} data-tip={remove.reason}>
                      <X size={13} />
                    </IconButton>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}
      <div className="message-queue-pile" data-behind={behind}>
        {Array.from({ length: behind }, (_, index) => (
          <span key={index} className="message-queue-behind" data-depth={index + 1} aria-hidden="true" />
        ))}
        <button type="button" className="message-queue-front" aria-expanded={open} onClick={() => setExpanded(!open)}>
          <span className="message-queue-count tabular">
            {messages.length} {paused ? "paused" : "queued"}
          </span>
          <span className="message-queue-hint">{paused ? people?.pausedHint : (people?.hint ?? queueHint(messages, agentName))}</span>
          <ChevronDown size={14} className="message-queue-chevron" />
        </button>
      </div>
    </section>
  );
}

/** A queued message's author, words, what went wrong with it and what it carries; pressed, they go back to the composer. */
function QueuedWords({ message, pending, onEdit, author }: { message: QueuedMessage; pending: boolean; onEdit: (() => void) | undefined; author?: ThreadPerson | null | undefined }) {
  const words = message.text.trim() || "Attached images";
  const control = useComposerControl(pending, words);
  const body = (
    <>
      {author !== undefined ? <QueueAuthor person={author} /> : null}
      <span className="message-queue-preview">{words}</span>
      {message.error ? (
        <span role="status" className="message-queue-error">
          {failureParts(message.error).headline}
        </span>
      ) : null}
      {message.attachments.length > 0 ? (
        <span className="message-queue-attachments">
          {message.attachments.length} {message.attachments.length === 1 ? "image" : "images"} attached
        </span>
      ) : null}
    </>
  );
  if (!onEdit) return <div className="message-queue-message">{body}</div>;
  return (
    <button type="button" className="message-queue-message" disabled={control.disabled} data-tip={control.reason} onClick={onEdit}>
      {body}
    </button>
  );
}

/** The author's own paused message starts their own turn, on their sign-in and hours; not while a turn runs. */
function QueuedStart({ canStart, blocked, pending, onStart }: { canStart: boolean; blocked: string | null; pending: boolean; onStart: () => void }) {
  const control = useComposerControl(!canStart || pending, canStart ? "Uses your sign-in and hours." : (blocked ?? "This message can't start a turn now."));
  return (
    <Button size="sm" disabled={control.disabled} data-tip={control.reason} onClick={onStart}>
      Start turn
    </Button>
  );
}

/**
 * A queued message's way on: Send now into the running turn, Retry after an interrupted delivery, or Try again once a
 * message the agent's host refused can start a turn. Each is disabled with its reason while it cannot work.
 */
function QueuedSend({
  message,
  canSend,
  pending,
  sendReason,
  retryBlocked,
  onSend,
}: {
  message: QueuedMessage;
  canSend: boolean;
  pending: boolean;
  sendReason?: string | null | undefined;
  retryBlocked?: string | null | undefined;
  onSend: (messageId: string) => void;
}) {
  const failed = Boolean(message.error) && !message.interrupted;
  let reason: string | null = sendReason ?? "Reaches the agent in its current turn.";
  if (message.interrupted) reason = "Retry delivery after checking the conversation.";
  if (failed) reason = retryBlocked ?? null;
  const ready = message.interrupted || (failed ? !retryBlocked : canSend);
  let label = "Send now";
  if (message.interrupted) label = "Retry";
  if (failed) label = "Try again";
  const control = useComposerControl(!ready || pending, reason);
  return (
    <Button size="sm" variant="ghost" disabled={control.disabled} data-tip={control.reason} onClick={() => onSend(message.id)}>
      {label}
    </Button>
  );
}
