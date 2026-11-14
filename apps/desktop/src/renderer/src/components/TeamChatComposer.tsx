import { useRef, useState } from "react";
import type { TeamChatFile, TeamChatPerson } from "@openorc/protocol";
import { cn } from "../lib/cn";
import { useTagging } from "../lib/team-chat-tagging";
import { ComposerEditor, type ComposerEditorHandle } from "./composer-editor/ComposerEditor";
import { ArrowUp } from "./icons";
import { TeamChatTagPicker } from "./TeamChatTagPicker";
import { TeamChatAttach, TeamChatAttachments, useTeamChatDraftFiles, type TeamChatComposerFiles } from "./TeamChatComposerFiles";
import { Tooltip } from "./ui";

export type { TeamChatComposerFiles } from "./TeamChatComposerFiles";

export interface TeamChatComposerProps {
  text: string;
  placeholder: string;
  reason: string | null;
  onChange(text: string): void;
  onSend(files: TeamChatFile[]): void;
  /** Who this conversation may tag; empty offers no list. */
  taggable?: readonly TeamChatPerson[];
  /** Everyone a tag here may name, so a draft or a sent tag reads as a name. */
  named?: readonly TeamChatPerson[];
  /** Attaching, which the server's files capability brings; absent offers no attach control. */
  files?: TeamChatComposerFiles | null;
}

export function TeamChatComposer({ text, placeholder, reason, onChange, onSend, taggable = [], named = [], files: place = null }: TeamChatComposerProps) {
  const editor = useRef<ComposerEditorHandle>(null);
  const shell = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState<number | null>(null);
  const tags = useTagging({ text, caret, taggable, named, editor });
  const draft = useTeamChatDraftFiles(place);
  const why = reason ?? draft.reason ?? (text.length > 10_000 ? "Messages can have up to 10,000 characters." : null);
  const disabled = Boolean(why) || (!text.trim() && !draft.ready.length);
  const send = () => {
    if (disabled) return;
    onSend(draft.ready);
    draft.sent();
  };
  const attach = (chosen: File[]) => {
    if (place) void draft.files.addFiles(chosen);
  };
  return (
    <div className="composer-padding team-chat-compose">
      <div className="mx-auto max-w-chat w-full composer">
        <div className="composer-shell" ref={shell}>
          {tags.matches.length ? <TeamChatTagPicker anchor={shell} people={tags.matches} cursor={tags.cursor} onCursor={tags.setCursor} onPick={tags.pick} onDismiss={tags.dismiss} /> : null}
          {place ? <TeamChatAttachments place={place} draft={draft} /> : null}
          <div className="composer-prompt">
            <ComposerEditor
              value={text}
              onChange={(change) => {
                setCaret(change.caret);
                if (change.text !== text) tags.reset();
                onChange(change.text);
              }}
              sources={tags.sources}
              onKeyDown={(event) => {
                if (tags.onKey(event)) return true;
                if (event.key !== "Enter" || event.shiftKey || event.isComposing) return false;
                event.preventDefault();
                send();
                return true;
              }}
              onFiles={attach}
              disabled={false}
              placeholder={placeholder}
              completion={{}}
              onFocus={() => {}}
              onBlur={() => setCaret(null)}
              handle={editor}
            />
          </div>
          <div className={cn("composer-bar", place && "team-chat-bar-files")}>
            {place ? <TeamChatAttach onFiles={attach} /> : null}
            <Tooltip label={why ?? "Send"}>
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
