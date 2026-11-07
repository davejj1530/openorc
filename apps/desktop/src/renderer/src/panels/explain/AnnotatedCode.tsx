import { Suspense, type ReactNode } from "react";
import type { LineNote, LineSpan } from "@openorc/protocol";
import { CodeExcerpt } from "../../components/code-editor";
import { useWordWrap } from "../../lib/word-wrap";
import { noteSegments } from "./note-segments";

export function Excerpt({ text, path, start, end }: { text: string; path: string; start: number; end: number }) {
  const wrap = useWordWrap((state) => state.wrap);
  return (
    <Suspense fallback={<pre className="code-excerpt" style={{ minHeight: (end - start + 1) * 20 + 16 }} />}>
      <CodeExcerpt text={text} path={path} start={start} end={end} wrap={wrap} />
    </Suspense>
  );
}

/** A note's words, with the code's own names in backticks set as code. */
function NoteText({ text }: { text: string }) {
  const parts: ReactNode[] = text.split(/(`[^`\n]+`)/g).map((part, index) => (part.length > 2 && part.startsWith("`") && part.endsWith("`") ? <code key={index}>{part.slice(1, -1)}</code> : part));
  return <p className="explain-note-text">{parts}</p>;
}

/** Lines `span` of the file, each note under the code it is about. `text` is the explained text, with LF breaks. */
export function AnnotatedCode({ notes, span, text, path }: { notes: readonly LineNote[]; span: LineSpan; text: string; path: string }) {
  const segments = noteSegments(notes, span, text.replace(/\n$/, "").split("\n"));
  return (
    <ol className="explain-notes">
      {segments.map((segment) => (
        <li key={segment.start} className="explain-note">
          <div className="explain-note-code">
            <Excerpt text={text} path={path} start={segment.start} end={segment.end} />
          </div>
          {segment.note ? <NoteText text={segment.note.text} /> : null}
        </li>
      ))}
    </ol>
  );
}
