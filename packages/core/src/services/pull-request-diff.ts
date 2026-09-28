import { commentAnchor, patchFiles, type CommentAnchor } from "@openorc/protocol";
import type { PullReviewComment } from "@openorc/mcp";

/** How much of a diff one tool result carries before the agent is asked to read it a file at a time. */
const AGENT_DIFF_LIMIT = 150_000;
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * `git diff` for a reviewing agent, shaped the way GitHub shapes a pull request's diff whatever the user's diff settings
 * say: GitHub takes comments only on lines of its own hunks, and one comment off them fails the whole review. The a/ and
 * b/ prefixes are what patchFiles reads names by.
 */
export const REVIEW_DIFF = [
  "-c",
  "diff.suppressBlankEmpty=false",
  "diff",
  "--no-color",
  "--no-ext-diff",
  "-M",
  "-U3",
  "--inter-hunk-context=0",
  "--diff-algorithm=default",
  "--indent-heuristic",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];

/** The files a diff changes with their line counts, for a pull request too large to read in one piece. */
function changedFileList(patch: string): string {
  return patchFiles(patch)
    .map((file) => {
      const lines = file.chunk.split("\n");
      const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
      const removed = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
      return `${file.path} (+${added} -${removed})`;
    })
    .join("\n");
}

function limited(text: string): string {
  return text.length <= AGENT_DIFF_LIMIT ? text : `${text.slice(0, AGENT_DIFF_LIMIT)}\n[Truncated. Read the rest of this file in your checkout.]`;
}

/** The diff an agent asked for: all of it, one file, or the file list when all of it is too long. */
export function agentDiff(patch: string, filePath: string | undefined, scope = "this pull request"): string {
  if (!patch.trim()) return `Nothing changed in ${scope}.`;
  if (filePath === undefined) {
    if (patch.length <= AGENT_DIFF_LIMIT) return patch;
    return `This pull request is too large to read at once. Ask for one path at a time. Changed files:\n${changedFileList(patch)}`;
  }
  const file = patchFiles(patch).find((entry) => entry.path === filePath);
  return file ? limited(file.chunk) : `${filePath} is not changed in ${scope}. Changed files:\n${changedFileList(patch)}`;
}

/**
 * Where an agent's comment attaches, checked the way GitHub will check it:
 * every line must be in the diff, and a range must stay inside one hunk.
 */
export function agentAnchor(chunk: string, comment: PullReviewComment): CommentAnchor {
  const end = { line: comment.line, side: comment.side };
  const start = comment.startLine === undefined ? end : { line: comment.startLine, side: comment.startSide ?? comment.side };
  const where = `${comment.path} line ${comment.line} (${comment.side} side)`;
  if (!commentAnchor(chunk, end, end)) throw new Error(`${where} is not in this pull request's diff. Comment on a line pull_request_diff shows.`);
  if (!commentAnchor(chunk, start, start)) throw new Error(`${comment.path} line ${start.line} (${start.side} side) is not in this pull request's diff.`);
  const anchor = commentAnchor(chunk, start, end)!;
  const single = start.line === end.line && start.side === end.side;
  const exact = anchor.line === end.line && anchor.side === end.side && (single ? anchor.startLine === null : anchor.startLine === start.line && anchor.startSide === start.side);
  if (!exact) throw new Error(`The range ending at ${where} must start above it, in the same hunk.`);
  return anchor;
}

interface Hunk {
  /** The new file's lines the hunk spans, first to last. */
  from: number;
  to: number;
  lines: string[];
}

/** One file's part of a diff: the lines before its first hunk, then each hunk. */
function hunksOf(chunk: string): { header: string[]; hunks: Hunk[] } {
  const header: string[] = [];
  const hunks: Hunk[] = [];
  for (const line of chunk.split("\n")) {
    const start = HUNK.exec(line);
    if (start) {
      const from = Number(start[1]);
      hunks.push({ from, to: from + Math.max(Number(start[2] ?? 1), 1) - 1, lines: [line] });
    } else if (hunks.length > 0) hunks.at(-1)!.lines.push(line);
    else header.push(line);
  }
  return { header, hunks };
}

/** The new file's lines a diff changed: added ones, and those either side of a removal. */
function changedLines(chunk: string): Set<number> {
  const changed = new Set<number>();
  for (const hunk of hunksOf(chunk).hunks) {
    let line = hunk.from;
    for (const row of hunk.lines.slice(1)) {
      if (row.startsWith("+")) changed.add(line++);
      else if (row.startsWith("-")) changed.add(line - 1).add(line);
      else if (row.startsWith(" ")) line++;
    }
  }
  return changed;
}

/**
 * The hunks of a pull request's diff that hold a change made after an earlier commit, found from the diff since that
 * commit. Both number the new side by the head, and this view keeps the full diff's own numbering on both sides, so a
 * line read here is one a comment can be checked against.
 */
export function changedSince(full: string, since: string): string {
  const changed = new Map(patchFiles(since).map((file) => [file.path, changedLines(file.chunk)]));
  return patchFiles(full)
    .flatMap((file) => {
      const lines = changed.get(file.path);
      if (!lines) return [];
      const { header, hunks } = hunksOf(file.chunk);
      const kept = hunks.filter((hunk) => [...lines].some((line) => line >= hunk.from && line <= hunk.to));
      return kept.length > 0 ? [[...header, ...kept.flatMap((hunk) => hunk.lines)].join("\n").trimEnd()] : [];
    })
    .map((file) => `${file}\n`)
    .join("");
}
