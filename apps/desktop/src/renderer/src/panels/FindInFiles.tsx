import { useEffect, useRef, useState, type ReactNode } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import type { FileScope, FindQuery, FindResult } from "@openorc/protocol";
import { Search } from "../components/icons";
import { Matches } from "../components/Matches";
import { ThreadMedia } from "../components/ThreadImages";
import { IconButton, Input, Tooltip } from "../components/ui";
import { cn } from "../lib/cn";
import { filesKey, useFilesFocus } from "../lib/files-tool";
import { useRpc } from "../lib/query";

type Found = Extract<FindResult, { kind: "matches" }>;

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What Matches marks: the query as the core searched it, so marks agree with the lines found. */
function findHighlight(query: FindQuery): RegExp | null {
  try {
    return new RegExp(query.regex ? query.text : escape(query.text), query.caseSensitive ? "g" : "gi");
  } catch {
    return null;
  }
}

/** Links decode their path, so each segment is encoded to keep names like `a:b.ts` or `100%.md` whole. */
const encodedPath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

function summary({ groups, truncated }: Found): string {
  if (!groups.length) return truncated ? "The search stopped before finding a match." : "No matches.";
  const lines = groups.reduce((sum, group) => sum + group.lines.length, 0);
  const found = `${lines} matching ${lines === 1 ? "line" : "lines"} in ${groups.length} ${groups.length === 1 ? "file" : "files"}`;
  return truncated ? `${found}. More matched than shown.` : `${found}.`;
}

/** The query once typing pauses, so each keystroke doesn't start a search. */
function useSettled(query: FindQuery): FindQuery {
  const [settled, setSettled] = useState(query);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(query), 250);
    return () => clearTimeout(timer);
  }, [query]);
  return settled;
}

function Toggle({ label, pressed, onChange, children }: { label: string; pressed: boolean; onChange: (pressed: boolean) => void; children: ReactNode }) {
  return (
    <Tooltip label={label}>
      <IconButton aria-label={label} aria-pressed={pressed} onClick={() => onChange(!pressed)} className={cn("font-mono text-sm", pressed && "bg-surface-2 text-ink")}>
        {children}
      </IconButton>
    </Tooltip>
  );
}

/** Find in files: lines in the conversation's folder grouped by file, each opening its file at that line in a tab. */
export function FindInFiles({ scope, query, onQuery }: { scope: FileScope; query: FindQuery; onQuery: (query: FindQuery) => void }) {
  const input = useRef<HTMLInputElement>(null);
  useFilesFocus(input);
  const settled = useSettled(query);
  const searching = settled.text.trim() !== "";
  // Fresh on every showing, and a find another one stopped is never shown as an answer.
  const find = useRpc("files.find", { scope, query: settled }, { enabled: searching, staleTime: 0, placeholderData: keepPreviousData });
  // The last query's lines stay while the next one runs, unmarked and under "Searching…", so the list doesn't flash.
  const stale = find.isPlaceholderData;
  let result = searching && find.data?.kind !== "superseded" ? find.data : undefined;
  if (stale && result?.kind === "invalid") result = undefined;
  return (
    <>
      <div className="shrink-0 flex items-center gap-1 px-2.5 pb-2.5">
        <Search size={15} className="mx-2 text-ink-4 shrink-0" />
        <Input
          ref={input}
          aria-label="Find in files"
          placeholder="Find in files…"
          maxLength={500}
          value={query.text}
          onChange={(event) => onQuery({ ...query, text: event.target.value })}
          className="flex-1"
        />
        <Toggle label="Match case" pressed={query.caseSensitive} onChange={(caseSensitive) => onQuery({ ...query, caseSensitive })}>
          Aa
        </Toggle>
        <Toggle label="Regex" pressed={query.regex} onChange={(regex) => onQuery({ ...query, regex })}>
          .*
        </Toggle>
      </div>
      <div className="flex-1 min-h-0 overflow-auto px-5 pb-2.5">
        {find.error ? (
          <p role="alert" className="text-sm text-ink-3">
            {find.error.message}
          </p>
        ) : null}
        {result?.kind === "invalid" ? (
          <p role="alert" className="text-sm text-bad break-words">
            {result.message}
          </p>
        ) : null}
        {result?.kind === "matches" ? (
          <>
            <p role="status" className="mb-1 text-sm text-ink-3">
              {stale ? "Searching…" : summary(result)}
            </p>
            <ThreadMedia scopeKey={filesKey(scope)} fileScope={scope}>
              <div className="tool-view">
                <Matches groups={result.groups} highlight={stale ? null : findHighlight(settled)} href={encodedPath} folded={false} rows />
              </div>
            </ThreadMedia>
          </>
        ) : null}
        {!result && find.isFetching ? (
          <p role="status" className="text-sm text-ink-3">
            Searching…
          </p>
        ) : null}
      </div>
    </>
  );
}
