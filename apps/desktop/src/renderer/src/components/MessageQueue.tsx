import type { QueuedMessage } from "@openorc/protocol";
import { ChevronDown, Clock, X } from "./icons";
import { Button, IconButton } from "./ui";

export function MessageQueue({
  messages,
  canSend,
  pending,
  sendReason,
  onSend,
  onRemove,
}: {
  messages: QueuedMessage[];
  canSend: boolean;
  pending: boolean;
  sendReason?: string | null;
  onSend: (messageId: string) => void;
  onRemove: (messageId: string) => void;
}) {
  if (!messages.length) return null;
  return (
    <section className="message-queue" aria-label="Queued messages">
      <div className="message-queue-header">
        <Clock size={14} />
        <span className="message-queue-title">
          Queued <span className="message-queue-count">{messages.length}</span>
        </span>
        <span className="message-queue-hint">Runs after this turn</span>
      </div>
      <ol className="message-queue-list">
        {messages.map((message, index) => (
          <li className="message-queue-row" key={message.id}>
            <span className="message-queue-position" aria-hidden="true">
              {index + 1}
            </span>
            <details className="message-queue-message">
              <summary aria-label={`Read queued message ${index + 1}`}>
                <span className="min-w-0 flex-1">
                  <span className="message-queue-preview">{message.text.trim() || "Attached images"}</span>
                  {message.error ? (
                    <span role="status" className="block text-xs text-bad">
                      {message.error}
                    </span>
                  ) : null}
                  {message.attachments.length > 0 ? (
                    <span className="message-queue-attachments">
                      {message.attachments.length} {message.attachments.length === 1 ? "image" : "images"} attached
                    </span>
                  ) : null}
                </span>
                <ChevronDown size={13} className="message-queue-chevron" />
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
              <IconButton size="sm" disabled={pending} onClick={() => onRemove(message.id)} aria-label={`Remove queued message ${index + 1}`} title="Remove from queue">
                <X size={13} />
              </IconButton>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
