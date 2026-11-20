import { useState } from "react";
import { hitText, type HitFile, type WorkChip } from "@openorc/client";
import { FileGlyph } from "./FileGlyph";
import { ThreadLink } from "./ThreadImages";
import { FilePeek } from "./WorkRead";

/** Files a search shows before the rest wait behind a count, and matching lines under each file that shows them. */
const FILES = 3;
const LINES = 2;
/** Lines a peek shows above and below the match. */
const BEFORE = 4;
const AFTER = 8;

/** `unseen` is how many more files it found than the ones here, which only the call itself can show. */
export function Found({ files, terms, unseen }: { files: HitFile[]; terms: string[]; unseen: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? files : files.slice(0, FILES);
  const hidden = files.length - shown.length;
  const more = hidden + Math.max(0, unseen);
  // The opened files show their lines; before anything is opened, the first file does.
  const anyOpened = files.some((file) => file.opened);
  return (
    <div className="work-found">
      {shown.map((file, index) => (
        <FoundFile key={file.path} file={file} terms={terms} lines={anyOpened ? file.opened : index === 0} />
      ))}
      {hidden > 0 ? (
        <button type="button" className="work-more" onClick={() => setAll(true)}>
          {more} more {more === 1 ? "file" : "files"}
        </button>
      ) : null}
      {hidden === 0 && unseen > 0 ? <span className="work-found-unseen">{unseen} more</span> : null}
    </div>
  );
}

function FoundFile({ file, terms, lines }: { file: HitFile; terms: string[]; lines: boolean }) {
  const [all, setAll] = useState(false);
  const first = file.lines[0]?.line;
  const listed = all ? file.lines : file.lines.slice(0, LINES);
  const shown = lines ? listed : [];
  const rest = lines ? file.lines.length - shown.length : 0;
  return (
    <div className="work-found-file" data-opened={file.opened || undefined}>
      <ThreadLink href={first === undefined ? file.path : `${file.path}:${first}`}>
        <FileGlyph path={file.name} size={14} className="work-chip-icon" />
        <span className="work-found-name">{file.name}</span>
        <span className="work-found-folder">{file.folder}</span>
      </ThreadLink>
      {shown.map((hit) => (
        <FoundLine key={hit.line} file={file} line={hit.line} text={hit.text} terms={terms} />
      ))}
      {rest > 0 ? (
        <button type="button" className="work-more work-found-rest" onClick={() => setAll(true)}>
          {rest} more
        </button>
      ) : null}
    </div>
  );
}

/** The file around a match as a read of those lines, which is what the peek draws. */
function around(file: HitFile, line: number): WorkChip {
  return {
    key: `${file.path}:${line}`,
    label: file.name,
    title: file.path,
    kind: "file",
    path: file.path,
    detail: file.folder,
    note: `line ${line}`,
    lines: { line: Math.max(1, line - BEFORE), endLine: line + AFTER },
    blocks: [],
  };
}

function FoundLine({ file, line, text, terms }: { file: HitFile; line: number; text: string; terms: string[] }) {
  const read = hitText(file.path, text, terms);
  return (
    <FilePeek chip={around(file, line)} className="work-found-line">
      <ThreadLink href={`${file.path}:${line}`}>
        <span className="work-found-number">{line}</span>
        <span className="work-found-text" data-prose={read.prose || undefined}>
          {read.parts.map((part, index) => (part.match ? <mark key={index}>{part.text}</mark> : part.text))}
        </span>
      </ThreadLink>
    </FilePeek>
  );
}
