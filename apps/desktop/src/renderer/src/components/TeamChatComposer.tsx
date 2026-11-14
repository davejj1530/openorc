import { useRef } from "react";
import { ComposerEditor, type ComposerEditorHandle } from "./composer-editor/ComposerEditor";
import { ArrowUp } from "./icons";
import { Tooltip } from "./ui";

export function TeamChatComposer({ text, placeholder, reason, onChange, onSend }: { text: string; placeholder: string; reason: string | null; onChange(text: string): void; onSend(): void }) {
  const editor = useRef<ComposerEditorHandle>(null);
  const disabled = Boolean(reason) || !text.trim() || text.length > 10_000;
  const send = () => {
    if (!disabled) onSend();
  };
  return (
    <div className="composer-padding team-chat-compose">
      <div className="mx-auto max-w-chat w-full composer">
        <div className="composer-shell">
          <div className="composer-prompt">
            <ComposerEditor
              value={text}
              onChange={({ text }) => onChange(text)}
              sources={{}}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey || event.isComposing) return false;
                event.preventDefault();
                send();
                return true;
              }}
              onFiles={() => {}}
              disabled={false}
              placeholder={placeholder}
              completion={{}}
              onFocus={() => {}}
              onBlur={() => {}}
              handle={editor}
            />
          </div>
          <div className="composer-bar justify-end">
            <Tooltip label={reason ?? (text.length > 10_000 ? "Messages can have up to 10,000 characters." : "Send")}>
              <button type="button" className="composer-send" aria-label="Send" disabled={disabled} onClick={send}>
                <ArrowUp size={18} />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  );
}
