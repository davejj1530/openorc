import { useState, type ReactNode } from "react";
import type { MatchGroup, MatchLine } from "@openorc/client";
import { FileGlyph } from "./FileGlyph";
import { ThreadLink } from "./ThreadImages";
import "./ToolDetail.css";

/** A path with its folder quiet and its name plain. */
function PathText({ path }: { path: string }) {
  const cut = path.replace(/[\\/]$/, "").search(/[^\\/]*$/);
  return (
    <>
      <span className="tool-view-dir">{path.slice(0, cut)}</span>
      {path.slice(cut)}
    </>
  );
}

/** A file as a row: its mark, its path as a link that opens it, and a note after. */
export function FileLine({ path, href = path, note, linked = true }: { path: string; href?: string; note?: ReactNode; linked?: boolean }) {
  return (
    <div className="tool-view-target">
      <FileGlyph path={path} />
      <span className="tool-view-link" title={linked ? undefined : href}>
        {linked ? (
          <ThreadLink href={href}>
            <PathText path={path} />
          </ThreadLink>
        ) : (
          <PathText path={path} />
        )}
      </span>
      {note ? <span className="tool-view-note">{note}</span> : null}
    </div>
  );
}

/** `text` with every match of `pattern` marked. Matching, not splitting, so a pattern's own groups don't repeat text. */
function marked(text: string, pattern: RegExp | null): ReactNode {
  if (!pattern?.global) return text;
  const parts: ReactNode[] = [];
  let from = 0;
  for (const match of text.matchAll(pattern)) {
    if (!match[0]) continue;
    parts.push(text.slice(from, match.index), <mark key={match.index}>{match[0]}</mark>);
    from = match.index + match[0].length;
  }
  parts.push(text.slice(from));
  return parts;
}

const MATCH_FILES = 6;
const MATCH_LINES = 5;

const matchCount = (group: MatchGroup) => group.lines.filter((line) => !line.context).length;

/** A group's lines up to its `count`th match, with the context printed around those matches. */
function firstMatches(lines: MatchLine[], count: number): MatchLine[] {
  const shown: MatchLine[] = [];
  let matches = 0;
  for (const line of lines) {
    if (!line.context && ++matches > count) break;
    shown.push(line);
  }
  return shown;
}

/**
 * Search results by file. A file's path opens it and a line's number opens it at that line.
 * - `highlight` is a global pattern; each match in a line is marked.
 * - `href` turns a path into the link that opens it.
 * - `folded` shows six files and five matches each until asked, as a tool's output does.
 * - `rows` lets a whole line open its file, for results the user works through one by one.
 */
export function Matches({
  groups,
  highlight,
  href,
  folded = true,
  rows = false,
}: {
  groups: MatchGroup[];
  highlight: RegExp | null;
  href: (path: string) => string;
  folded?: boolean;
  rows?: boolean;
}) {
  const [all, setAll] = useState(!folded);
  const total = groups.reduce((sum, group) => sum + matchCount(group), 0);
  const shown = all ? groups : groups.slice(0, MATCH_FILES);
  const hidden = total - shown.reduce((sum, group) => sum + Math.min(matchCount(group), MATCH_LINES), 0);
  return (
    <div className="tool-view-matches" data-rows={rows || undefined}>
      {shown.map((group) => {
        const link = href(group.path);
        return (
          <section key={group.path}>
            <FileLine path={group.path} href={link} note={matchCount(group)} />
            <ol>
              {(all ? group.lines : firstMatches(group.lines, MATCH_LINES)).map((line, index) => (
                <li key={index} title={line.text} data-context={line.context || undefined}>
                  <span className="tool-view-line">{line.line === null ? null : <ThreadLink href={`${link}:${line.line}`}>{line.line}</ThreadLink>}</span>
                  <code>{line.context ? line.text : marked(line.text, highlight)}</code>
                </li>
              ))}
            </ol>
          </section>
        );
      })}
      {!all && hidden > 0 ? (
        <button type="button" className="tool-view-more" onClick={() => setAll(true)}>
          Show all {total} matches
        </button>
      ) : null}
    </div>
  );
}
