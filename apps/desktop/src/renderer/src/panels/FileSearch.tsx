import { useDeferredValue, useEffect, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import type { FileScope, FindGroup, FindQuery, FindResult } from "@openorc/protocol";
import { FileGlyph } from "../components/FileGlyph";
import { ChevronRight, Folder } from "../components/icons";
import { Matches } from "../components/Matches";
import { ThreadMedia } from "../components/ThreadImages";
import { IconButton, Tooltip } from "../components/ui";
import { cn } from "../lib/cn";
import { useRpc } from "../lib/client";
import { filesKey, type FilesTool } from "../lib/files-tool";
import { useLayout } from "../lib/layout";

/** File names asked for, the most the core gives. */
const NAME_LIMIT = 50;
/** Lines are searched once this much is typed: fewer letters match nearly every file. */
const LINE_QUERY = 3;

/**
 * The letters of a path the query matched, by the rule the core ranks names with: a run in the file's name, else a run
 * in its path, else each letter in order.
 */
export function matchedLetters(path: string, query: string): Set<number> {
  const q = query.toLowerCase();
  const lower = path.toLowerCase();
  const run = (from: number) => new Set(Array.from({ length: q.length }, (_, index) => from + index));
  const inName = lower.indexOf(q, lower.lastIndexOf("/") + 1);
  if (inName >= 0) return run(inName);
  const inPath = lower.indexOf(q);
  if (inPath >= 0) return run(inPath);
  const hits = new Set<number>();
  for (let index = 0, at = 0; index < lower.length && at < q.length; index += 1) {
    if (lower[index] !== q[at]) continue;
    hits.add(index);
    at += 1;
  }
  return hits;
}

/** Part of a path, from `offset`, with its matched letters in blue. */
function Marked({ text, offset, hits }: { text: string; offset: number; hits: Set<number> }) {
  const parts: ReactNode[] = [];
  let from = 0;
  for (let index = 1; index <= text.length; index += 1) {
    const hit = hits.has(offset + from);
    if (index < text.length && hits.has(offset + index) === hit) continue;
    const part = text.slice(from, index);
    parts.push(
      hit ? (
        <span key={from} className="file-search-hit">
          {part}
        </span>
      ) : (
        part
      ),
    );
    from = index;
  }
  return parts;
}

const nameStart = (path: string) => path.lastIndexOf("/") + 1;
const open = (scope: FileScope, path: string) => useLayout.getState().openFile({ path, scope });

/** Whether a file shows in the tree as it stands: every folder above it is open. */
function inOpenFolders(path: string, folders: ReadonlySet<string>): boolean {
  const parts = path.split("/").slice(0, -1);
  return folders.has("") && parts.every((_, index) => folders.has(parts.slice(0, index + 1).join("/")));
}

type Branch = Map<string, Branch>;

/** The letters of a folder's name the query names as a run, which marks a folder a match in its path came from. */
function runIn(name: string, query: string): Set<number> {
  const at = query ? name.toLowerCase().indexOf(query.toLowerCase()) : -1;
  return new Set(at < 0 ? [] : Array.from({ length: query.length }, (_, index) => at + index));
}

/** The open folders' matching files, in their folders as the tree draws them, the folders above each held open. */
function TreeMatches({ scope, root, paths, query, best }: { scope: FileScope; root: string; paths: string[]; query: string; best: string | undefined }) {
  const tree: Branch = new Map();
  for (const path of paths) {
    let branch = tree;
    for (const part of path.split("/")) branch = branch.get(part) ?? branch.set(part, new Map()).get(part)!;
  }
  const rows = (branch: Branch, prefix: string, level: number): ReactNode[] =>
    [...branch.entries()]
      .sort(([a, x], [b, y]) => Number(y.size > 0) - Number(x.size > 0) || a.localeCompare(b))
      .map(([name, children]) => {
        const path = prefix ? `${prefix}/${name}` : name;
        const indent = { paddingLeft: 8 + (level - 1) * 14 };
        if (!children.size)
          return (
            <button
              key={path}
              type="button"
              data-result
              data-best={path === best || undefined}
              className="file-tree-row file-search-file"
              style={indent}
              aria-label={path}
              data-tip={path}
              onClick={() => open(scope, path)}
            >
              <span className="w-3 shrink-0" />
              <FileGlyph path={path} size={14} />
              <span className="truncate">
                <Marked text={name} offset={nameStart(path)} hits={matchedLetters(path, query)} />
              </span>
            </button>
          );
        return (
          <div key={path}>
            <div className="file-tree-row file-search-branch" style={indent}>
              <ChevronRight size={12} className="rotate-90" />
              <Folder size={14} className="file-tree-folder" />
              <span className="truncate">
                <Marked text={name} offset={0} hits={runIn(name, query)} />
              </span>
            </div>
            <div className="file-tree-group">
              <span aria-hidden="true" className="file-tree-guide" style={{ left: 14 + (level - 1) * 14 }} />
              {rows(children, path, level + 1)}
            </div>
          </div>
        );
      });
  return (
    <div role="group" aria-label="In open folders">
      <div className="file-tree-row file-tree-root file-search-branch" data-tip={root}>
        <ChevronRight size={12} className="rotate-90" />
        <Folder size={14} className="file-tree-folder" />
        <span className="truncate">{root}</span>
      </div>
      {rows(tree, "", 2)}
    </div>
  );
}

/** A section of the search's results under its heading, with what it counts and its own controls. */
function Section({ title, count, tools, children }: { title: string; count?: string | undefined; tools?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="file-search-section">
      <header className="file-search-heading">
        <span>{title}</span>
        {count ? <span className="tabular">{count}</span> : null}
        {tools}
      </header>
      {children}
    </section>
  );
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Links decode their path, so each segment is encoded to keep names like `a:b.ts` or `100%.md` whole. */
const encodedPath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** What the lines' marks follow: the query as the core searched it, so marks agree with the lines found. */
function findHighlight(query: FindQuery): RegExp | null {
  try {
    return new RegExp(query.regex ? query.text : escape(query.text), query.caseSensitive ? "g" : "gi");
  } catch {
    return null;
  }
}

/** The query once typing pauses, so each keystroke doesn't start a search through every file. */
function useSettled(text: string, caseSensitive: boolean, regex: boolean): FindQuery {
  const [settled, setSettled] = useState<FindQuery>({ text, caseSensitive, regex });
  useEffect(() => {
    const timer = setTimeout(() => setSettled({ text, caseSensitive, regex }), 400);
    return () => clearTimeout(timer);
  }, [text, caseSensitive, regex]);
  return settled;
}

function Toggle({ label, pressed, onChange, children }: { label: string; pressed: boolean; onChange: (pressed: boolean) => void; children: ReactNode }) {
  return (
    <Tooltip label={label}>
      <IconButton size="xs" aria-label={label} aria-pressed={pressed} onClick={() => onChange(!pressed)} className={cn("font-mono text-xs", pressed && "bg-surface-2 text-ink")}>
        {children}
      </IconButton>
    </Tooltip>
  );
}

/** The lines found, by file: the first files and the first lines in each, the rest on asking. */
function FoundLines({ scope, groups, highlight, stale }: { scope: FileScope; groups: FindGroup[]; highlight: RegExp | null; stale: boolean }) {
  return (
    <ThreadMedia scopeKey={filesKey(scope)} fileScope={scope}>
      <div className={cn("tool-view file-search-lines", stale && "opacity-60")}>
        <Matches groups={groups} highlight={highlight} href={encodedPath} rows />
      </div>
    </ThreadMedia>
  );
}

/** What the find says besides its lines: a pattern it can't read, a failure, that it is still looking, or that no line holds the text. */
function LineNotice({ result, error, searching }: { result: FindResult | undefined; error: Error | null; searching: boolean }) {
  if (result?.kind === "invalid")
    return (
      <p role="alert" className="file-tree-notice text-bad">
        {result.message}
      </p>
    );
  if (error)
    return (
      <p role="alert" className="file-tree-notice">
        {error.message}
      </p>
    );
  if (searching)
    return (
      <p role="status" className="file-tree-notice">
        Searching…
      </p>
    );
  if (result?.kind !== "matches" || result.groups.length) return null;
  // A find that ran out of time with nothing found has not shown that nothing matches.
  return <p className="file-tree-notice">{result.truncated ? "The search stopped before finding a match." : "No lines match."}</p>;
}

/** Whether a query searches inside files: three letters, or fewer once Regex or Match case says it is exact. */
function searchable({ text, regex, caseSensitive }: FindQuery): boolean {
  const length = text.trim().length;
  return length >= LINE_QUERY || (length > 0 && (regex || caseSensitive));
}

type Find = ReturnType<typeof useFind>;

/** The find for the settled query: fresh on every showing, and a find another one stopped is never shown as an answer. */
function useFind(scope: FileScope, settled: FindQuery) {
  const find = useRpc("files.find", { scope, query: settled }, { enabled: searchable(settled), staleTime: 0, placeholderData: keepPreviousData });
  const result = find.data?.kind === "superseded" ? undefined : find.data;
  return { find, result, groups: result?.kind === "matches" ? result.groups : [] };
}

/** How many lines the find holds, `+` when it stopped early. */
function lineCount({ result, groups }: Find): string | undefined {
  const lines = groups.reduce((sum, group) => sum + group.lines.length, 0);
  return lines ? `${plural(lines, "line")}${result?.kind === "matches" && result.truncated ? "+" : ""}` : undefined;
}

/** The lines found for the settled query, under Searching… while the next find runs. */
function LineResults({ scope, found, settled, current }: { scope: FileScope; found: Find; settled: FindQuery; current: FindQuery }) {
  const { find, result, groups } = found;
  const stale = find.isPlaceholderData || settled.text !== current.text;
  return (
    <>
      <LineNotice result={stale ? undefined : result} error={find.error} searching={stale || (!result && find.isFetching)} />
      {groups.length ? <FoundLines key={JSON.stringify(settled)} scope={scope} groups={groups} highlight={stale ? null : findHighlight(settled)} stale={stale} /> : null}
    </>
  );
}

/** Lines in the project's files that hold the query once typing pauses, under the heading that sets how they match. */
function LineMatches({ scope, tool, update }: { scope: FileScope; tool: FilesTool; update: (change: Partial<FilesTool>) => void }) {
  const current = { text: tool.query, caseSensitive: tool.caseSensitive, regex: tool.regex };
  const settled = useSettled(tool.query, tool.caseSensitive, tool.regex);
  const found = useFind(scope, settled);
  const shown = searchable(current);
  return (
    <Section
      title="In files"
      count={shown ? lineCount(found) : undefined}
      tools={
        <span className="file-search-toggles">
          <Toggle label="Match case" pressed={tool.caseSensitive} onChange={(caseSensitive) => update({ caseSensitive })}>
            Aa
          </Toggle>
          <Toggle label="Regex" pressed={tool.regex} onChange={(regex) => update({ regex })}>
            .*
          </Toggle>
        </span>
      }
    >
      {shown ? <LineResults scope={scope} found={found} settled={settled} current={current} /> : null}
    </Section>
  );
}

/** What the name search says besides its names: that it is looking, that none match, or that more matched than show. */
function NameNotice({ count, loading, stale, regex }: { count: number | undefined; loading: boolean; stale: boolean; regex: boolean }) {
  if (loading)
    return (
      <p role="status" className="file-tree-notice">
        Searching…
      </p>
    );
  // A pattern is for the lines; its letters naming no file says nothing.
  if (stale || regex) return null;
  if (count === 0) return <p className="file-tree-notice">No file names match.</p>;
  return count === NAME_LIMIT ? <p className="file-tree-notice">Showing the first {NAME_LIMIT} names.</p> : null;
}

const results = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>("[data-result], .file-search-lines a[href], .file-search-lines button")];

/** The search's first result as drawn, which Down from the search box moves to. */
export const firstResult = (container: HTMLElement | null): HTMLElement | undefined => (container ? results(container)[0] : undefined);

/** The name the core ranked best, wherever it is drawn, which Enter in the search box opens. */
export const bestResult = (container: HTMLElement | null): HTMLElement | null => container?.querySelector<HTMLElement>("[data-best]") ?? null;

/**
 * The Files search as it narrows: the open folders' matching files where the tree draws them, the rest of the
 * project's matching names, then the lines that hold it once enough is typed. Up and Down move through them, Up from
 * the first back to the search box.
 */
export function FileSearchResults({
  ref,
  scope,
  root,
  folders,
  tool,
  update,
  onBack,
}: {
  ref: Ref<HTMLDivElement>;
  scope: FileScope;
  root: string;
  /** The folders open in the tree. */
  folders: readonly string[];
  tool: FilesTool;
  update: (change: Partial<FilesTool>) => void;
  onBack: () => void;
}) {
  const typed = tool.query.trim();
  const query = useDeferredValue(typed);
  const names = useRpc("files.search", { scope, query, limit: NAME_LIMIT }, { placeholderData: keepPreviousData });
  // Names from a query still being replaced stay, dimmed and unmarked, and Enter waits for the new ones.
  const stale = names.isPlaceholderData || query !== typed;
  const marks = stale ? "" : query;
  const openFolders = new Set(folders);
  const found = names.data ?? [];
  const best = stale ? undefined : found[0];
  const inTree = found.filter((path) => inOpenFolders(path, openFolders));
  const elsewhere = found.filter((path) => !inOpenFolders(path, openFolders));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const list = results(event.currentTarget);
    const at = list.indexOf(event.target as HTMLElement);
    if (at < 0) return;
    event.preventDefault();
    if (event.key === "ArrowDown") list[at + 1]?.focus();
    else if (at === 0) onBack();
    else list[at - 1]?.focus();
  };
  return (
    <div ref={ref} className="file-search" onKeyDown={onKeyDown}>
      <div className={cn(stale && "opacity-60")}>
        {inTree.length ? <TreeMatches scope={scope} root={root} paths={inTree} query={marks} best={best} /> : null}
        {elsewhere.length ? (
          <Section title="More in the project">
            {elsewhere.map((path) => {
              const hits = matchedLetters(path, marks);
              const cut = nameStart(path);
              return (
                <button
                  key={path}
                  type="button"
                  data-result
                  data-best={path === best || undefined}
                  className="file-tree-row file-search-file"
                  aria-label={path}
                  data-tip={path}
                  onClick={() => open(scope, path)}
                >
                  <FileGlyph path={path} size={14} />
                  <span className="truncate">
                    <Marked text={path.slice(cut)} offset={cut} hits={hits} />
                  </span>
                  <span className="file-search-folder">
                    <Marked text={path.slice(0, Math.max(0, cut - 1))} offset={0} hits={hits} />
                  </span>
                </button>
              );
            })}
          </Section>
        ) : null}
        {names.error ? (
          <p role="alert" className="file-tree-notice">
            {names.error.message}
          </p>
        ) : null}
      </div>
      <NameNotice count={names.data?.length} loading={names.isPending} stale={stale} regex={tool.regex} />
      <LineMatches scope={scope} tool={tool} update={update} />
    </div>
  );
}
