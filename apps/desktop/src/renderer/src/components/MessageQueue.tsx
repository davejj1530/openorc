import { useState } from "react";
import type { QueuedMessage } from "@openorc/protocol";
import { ChevronDown, X } from "./icons";
import { Button, IconButton } from "./ui";

/**
 * Messages waiting for the turn to finish, as a pile above the composer: a front card with the
 * count and up to two cards behind it. Clicking the front fans the pile out into the messages,
 * each with Send now and Remove. A message that failed to send opens it on its own.
 */
export function MessageQueue({
  messages,
  canSend,
  pending,
  sendReason,
  agentName,
  onSend,
  onRemove,
}: {
  messages: QueuedMessage[];
  canSend: boolean;
  pending: boolean;
  sendReason?: string | null;
  /** The agent working the turn, named in the pile's hint ("Sends when Codex finishes"). */
  agentName?: string;
  onSend: (messageId: string) => void;
  onRemove: (messageId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!messages.length) return null;
  const open = expanded || messages.some((message) => message.error || message.interrupted);
  const behind = open ? 0 : Math.min(2, messages.length);
  return (
    <section className="message-queue" aria-label="Queued messages">
      {open ? (
        <ol className="message-queue-list motion-stagger">
          {messages.map((message, index) => (
            <li className="message-queue-card motion-arrive" key={message.id}>
              <details className="message-queue-message">
                <summary aria-label={`Read queued message ${index + 1}`}>
                  <span className="message-queue-preview">{message.text.trim() || "Attached images"}</span>
                  {message.error ? (
                    <span role="status" className="message-queue-error">
                      {message.error}
                    </span>
                  ) : null}
                  {message.attachments.length > 0 ? (
                    <span className="message-queue-attachments">
                      {message.attachments.length} {message.attachments.length === 1 ? "image" : "images"} attached
                    </span>
                  ) : null}
                </summary>
              </details>
              <div className="message-queue-actions">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={(!canSend && !message.interrupted) || pending}
                  title={message.interrupted ? "Retry delivery after checking the conversation." : (sendReason ?? "Reaches the agent in its current turn.")}
                  onClick={() => onSend(message.id)}
                >
                  {message.interrupted ? "Retry" : "Send now"}
                </Button>
                <IconButton size="xs" disabled={pending} onClick={() => onRemove(message.id)} aria-label={`Remove queued message ${index + 1}`} title="Remove from queue">
                  <X size={13} />
                </IconButton>
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      <div className="message-queue-pile" data-behind={behind}>
        {Array.from({ length: behind }, (_, index) => (
          <span key={index} className="message-queue-behind" data-depth={index + 1} aria-hidden="true" />
        ))}
        <button type="button" className="message-queue-front" aria-expanded={open} onClick={() => setExpanded(!open)}>
          <span className="message-queue-count tabular">{messages.length} queued</span>
          <span className="message-queue-hint">{agentName ? `Sends when ${agentName} finishes` : "Runs after this turn"}</span>
          <ChevronDown size={14} className="message-queue-chevron" />
        </button>
      </div>
    </section>
  );
}
