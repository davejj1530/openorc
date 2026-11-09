import { useContext, useRef, type ReactNode } from "react";
import { isImagePath } from "../../../shared/image-paths";
import { FileText, GitFork } from "./icons";
import { MarkedText, MessageMarks, SkillHoverCard, useSkillHover } from "./MarkedText";
import { CopyMessage, MessageTime } from "./MessageActions";
import { ThreadImage } from "./ThreadImages";
import { IconButton } from "./ui";

/** The user's message: what they attached, then their words as the composer drew them, then copy, fork and when. A badge, such as a reaction, rests on the bubble. */
export function UserMessage({
  text,
  at,
  attachments,
  onFork,
  badge,
}: {
  text: string;
  at?: number | undefined;
  attachments?: string[] | undefined;
  onFork?: (() => void) | undefined;
  badge?: ReactNode;
}) {
  const marks = useContext(MessageMarks);
  const bubble = useRef<HTMLDivElement>(null);
  const skillHover = useSkillHover(bubble);
  return (
    <div className="group journal-message journal-prompt">
      <div className="journal-message-body grid gap-2">
        {attachments && attachments.length > 0 ? (
          <div className="flex flex-wrap gap-2 justify-end">
            {attachments.map((a) =>
              isImagePath(a) ? <ThreadImage key={a} src={`openorc-asset://attachments/${a.split("/").pop() ?? ""}`} alt="Attached image" compact /> : <AttachedFile key={a} path={a} />,
            )}
          </div>
        ) : null}
        <div ref={bubble} className="message-bubble text-prose whitespace-pre-wrap" onPointerMove={skillHover.onPointerMove} onPointerLeave={skillHover.onPointerLeave}>
          <MarkedText text={text} commands={marks.commands} connectors={marks.connectors} />
          {badge}
        </div>
        <SkillHoverCard mark={skillHover.hovered} commands={marks.commands} />
        <div className="journal-message-actions">
          {text ? <CopyMessage text={text} /> : null}
          {onFork ? <ForkButton onFork={onFork} /> : null}
          <MessageTime at={at} />
        </div>
      </div>
    </div>
  );
}

function ForkButton({ onFork }: { onFork: () => void }) {
  return (
    <IconButton size="md" onClick={() => onFork()} title="Continue this conversation in a new thread" aria-label="Fork thread" className="message-action">
      <GitFork size={16} />
    </IconButton>
  );
}

/**
 * An attachment with nothing to preview. The stored name keeps the one the
 * user gave it after the id that makes it unique, so the chip prints that and
 * opens the file where it lives.
 */
function AttachedFile({ path }: { path: string }) {
  const stored = path.split(/[\\/]/).pop() ?? path;
  const name = /^[a-f0-9-]{36}-/.test(stored) ? stored.slice(37) : stored;
  return (
    <button type="button" onClick={() => window.openorc.revealFile(path)} title={`Show in folder: ${path}`} className="attached-file">
      <FileText size={16} className="shrink-0 text-ink-4" />
      <span className="truncate">{name}</span>
    </button>
  );
}
