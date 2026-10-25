import path from "node:path";
import { redact } from "@openorc/db";

/** The Mac's folders a phone never hears of. Paths inside a project or a worktree read as repository-relative. */
export interface MacRoots {
  home: string;
  /** OpenOrc's data folder; its worktrees live at `worktrees/<project>/<conversation>`. */
  dataDir: string;
  /** Every project's checkout. */
  projects: readonly string[];
}

interface Root {
  /** The folder, escaped for a pattern, with the segments under it that still name the root (a worktree's two). */
  pattern: string;
  /** What the root reads as when a message names it alone. */
  label: (matched: string) => string;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A path segment Git or a hook could print: anything up to a slash, a space, a quote or a bracket. */
const SEGMENT = "[^/\\s\"'<>()[\\]]+";
/** What can end a path that names a root alone: a sentence's or a quote's end, a colon or comma, a bracket. */
const ROOT_END = "(?=[\\s\"'<>()[\\]:,;]|\\.(?:\\s|$)|$)";
function basename(matched: string): string {
  const folder = matched.replace(/^file:\/\//, "");
  try {
    return path.basename(decodeURI(folder));
  } catch {
    return path.basename(folder);
  }
}

/** The same folder as Node, a file URL and macOS's `/private` link might print it. */
function spellings(folder: string): string[] {
  const resolved = path.resolve(folder);
  const bare = resolved.replace(/^\/private(?=\/(?:var|tmp|etc)(?:\/|$))/, "");
  const linked = /^\/(?:var|tmp|etc)(?:\/|$)/.test(bare) ? [bare, `/private${bare}`] : [resolved];
  return [...new Set(linked.flatMap((spelling) => [spelling, encodeURI(spelling)]))];
}

function roots({ home, dataDir, projects }: MacRoots): Root[] {
  const entries: { folder: string; depth: number; label: (matched: string) => string }[] = [
    ...projects.map((folder) => ({ folder, depth: 0, label: basename })),
    { folder: path.join(dataDir, "worktrees"), depth: 2, label: basename },
    { folder: dataDir, depth: 0, label: basename },
    { folder: home, depth: 0, label: () => "~" },
  ];
  return entries
    .flatMap(({ folder, depth, label }) => spellings(folder).map((spelling) => ({ spelling, pattern: escape(spelling) + `(?:/${SEGMENT})`.repeat(depth), label })))
    .sort((a, b) => b.spelling.length - a.spelling.length)
    .map(({ pattern, label }) => ({ pattern, label }));
}

/** GitError's ` in <cwd>` before git's own words. */
const GIT_CWD = / failed \(([^)]*)\) in \/[^\n]*?: /g;
/** An absolute path outside the known roots, such as a tool under /opt; it keeps its last part. */
const SYSTEM_PATH = /(^|[\s"'(=<[]|file:\/\/)\/(?:Users|private|var|tmp|Volumes|opt|Applications|Library|System|home)(?:\/[^\s"'():,<>[\]]*)+/g;

/**
 * An error as a phone hears it: redacted, since hook output and git's stderr can hold a token, and without the Mac's
 * folders, which name its user and say nothing a phone can act on. A known root comes off by prefix, so a path with
 * spaces, after a bracket or in a file URL loses it too, and what is left is relative to the repository.
 */
export function remoteError(message: string, macRoots: MacRoots): string {
  let text = redact(message).text.replace(GIT_CWD, " failed ($1): ");
  if (!text.includes("/")) return text;
  for (const root of roots(macRoots)) {
    text = text.replace(new RegExp(`(?:file://)?${root.pattern}(?:/|${ROOT_END})`, "g"), (matched) => (matched.endsWith("/") ? "" : root.label(matched)));
  }
  return text.replace(SYSTEM_PATH, (match, lead: string) => (lead === "file://" ? "" : lead) + path.basename(match.slice(lead.length)));
}
