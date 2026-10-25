import { lstat, mkdtemp, rm } from "node:fs/promises";
import type { Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHANGES_LISTED, FILE_DIFF_BYTES, FILE_DIFF_LINES, type FileChange, type FileChangeStat, type FileDiff, type FileDiffBody, type WorkspaceChanges } from "@openorc/protocol";
import { git, GitError } from "./exec.js";
import { changedFileStatus, headOrEmptyTree, MAX_UNTRACKED_DIFF_BYTES, untrackedFiles } from "./repo.js";

/** Pathspecs name files exactly: `:(glob)*` or `*` in a file name is that name, never a pattern. */
const LITERAL = { GIT_LITERAL_PATHSPECS: "1" };
const PATCH = ["diff", "--no-color", "--no-ext-diff"];
const NUMSTAT = ["diff", "--numstat", "-z"];
/** A `diff --raw -z` entry's header: modes, object ids and the status letter with its score. */
const RAW_ENTRY = /^:\d+ \d+ [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/;
/** The throwaway index's settings, as in patchAgainst: no split index or fsmonitor, and executable bits kept. */
const INDEX_CONFIG = ["-c", "core.splitIndex=false", "-c", "core.fsmonitor=false", "-c", "core.filemode=true"];
const noLines: FileDiffBody = { kind: "text", insertions: 0, deletions: 0 };

export type ChangeList = Pick<WorkspaceChanges, "totals" | "files" | "unlisted">;

/**
 * Every change against `baseSha` (HEAD when null) with its line counts, untracked files included: tracked ones from
 * one `diff --raw --numstat`, untracked ones by numstat over a throwaway intent-to-add index. The list stops at
 * CHANGES_LISTED in git's order; the totals count every file.
 */
export async function changeStats(cwd: string, baseSha: string | null): Promise<ChangeList> {
  const base = baseSha ?? (await headOrEmptyTree(cwd));
  const [tracked, untracked] = await Promise.all([trackedStats(cwd, base), untrackedFiles(cwd).then((files) => untrackedStats(cwd, files))]);
  const files = [...tracked, ...untracked];
  const totals = { files: files.length, insertions: 0, deletions: 0 };
  for (const { body } of files) {
    if (body.kind !== "text") continue;
    totals.insertions += body.insertions;
    totals.deletions += body.deletions;
  }
  return { totals, files: files.slice(0, CHANGES_LISTED), unlisted: Math.max(0, files.length - CHANGES_LISTED) };
}

/** One changed file's hunks against `baseSha` (HEAD when null), cut to size. Null when the path has no changes. */
export async function filePatch(cwd: string, baseSha: string | null, file: string): Promise<FileDiff | null> {
  const base = baseSha ?? (await headOrEmptyTree(cwd));
  let tracked = (await trackedStats(cwd, base, file)).find((change) => change.path === file);
  // Alone, either side of a rename reads as added or deleted; only the whole diff pairs them up.
  if (tracked?.status === "added" || tracked?.status === "deleted") tracked = (await trackedStats(cwd, base)).find((change) => change.path === file);
  if (tracked) {
    const paths = ["--", ...(tracked.oldPath ? [tracked.oldPath] : []), tracked.path];
    return fileDiff(tracked, tracked.body, (await git(cwd, [...PATCH, "-M", base, ...paths], { env: LITERAL, okCodes: [0, 1] })).stdout);
  }
  if (!(await untrackedFiles(cwd, file)).includes(file)) return null;
  const stat = await lstat(path.join(cwd, file)).catch(() => null);
  if (!stat) return null;
  const change: FileChange = { path: file, status: "untracked", oldPath: null };
  const omitted = omittedBody(stat);
  if (omitted) return fileDiff(change, omitted, "");
  const [counts = "", patch = ""] = await intentToAdd(
    cwd,
    [file],
    [
      [...NUMSTAT, "--no-renames", "--", file],
      [...PATCH, "--no-renames", "--", file],
    ],
  );
  return fileDiff(change, numstat(counts).get(file) ?? noLines, patch);
}

/**
 * Tracked changes against `base`, staged or not, with their counts, in git's order: one `diff --raw --numstat` call
 * (the raw entries name the status, the numstat ones the counts), limited to `file` when given.
 */
async function trackedStats(cwd: string, base: string, file?: string): Promise<FileChangeStat[]> {
  const args = ["diff", "--raw", "--numstat", "-z", "-M", base, ...(file === undefined ? [] : ["--", file])];
  const parts = (await git(cwd, args, { env: LITERAL, okCodes: [0, 1] })).stdout.split("\0");
  const changes: FileChange[] = [];
  let i = 0;
  for (let entry = RAW_ENTRY.exec(parts[i] ?? ""); entry; entry = RAW_ENTRY.exec(parts[i] ?? "")) {
    const letter = entry[1];
    if (letter === "R" || letter === "C") {
      changes.push({ path: parts[i + 2] ?? "", status: "renamed", oldPath: parts[i + 1] ?? "" });
      i += 3;
    } else {
      changes.push({ path: parts[i + 1] ?? "", status: changedFileStatus(letter), oldPath: null });
      i += 2;
    }
  }
  const counts = numstat(parts.slice(i).join("\0"));
  return changes.map((change) => ({ ...change, body: counts.get(change.path) ?? noLines }));
}

/** Why an untracked file gets no text diff: over 1 MB, or neither a regular file nor a symlink. Null otherwise. */
function omittedBody(stat: Stats): FileDiffBody | null {
  if (stat.isSymbolicLink() || (stat.isFile() && stat.size <= MAX_UNTRACKED_DIFF_BYTES)) return null;
  return stat.isFile() ? { kind: "omitted", reason: "large", bytes: stat.size } : { kind: "omitted", reason: "special", bytes: null };
}

/** `diff --numstat -z` by each file's new path. A rename prints an empty path, then its old and new paths. */
function numstat(out: string): Map<string, FileDiffBody> {
  const counts = new Map<string, FileDiffBody>();
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    const first = entry.indexOf("\t");
    const second = entry.indexOf("\t", first + 1);
    if (first === -1 || second === -1) continue;
    let file = entry.slice(second + 1);
    if (file === "") {
      file = parts[i + 2] ?? "";
      i += 2;
    }
    const insertions = entry.slice(0, first);
    counts.set(file, insertions === "-" ? { kind: "binary" } : { kind: "text", insertions: Number(insertions), deletions: Number(entry.slice(first + 1, second)) });
  }
  return counts;
}

/**
 * Untracked files with their counts. lstat, never stat: a symlink is counted as the link it is, and nothing here
 * opens a fifo, a socket or what a link points at. A file gone since it was listed is left out.
 */
async function untrackedStats(cwd: string, files: string[]): Promise<FileChangeStat[]> {
  const stats = await Promise.all(files.map((file) => lstat(path.join(cwd, file)).catch(() => null)));
  const bodies = new Map<string, FileDiffBody>();
  const countable: string[] = [];
  files.forEach((file, index) => {
    const stat = stats[index];
    if (!stat) return;
    const omitted = omittedBody(stat);
    if (omitted) bodies.set(file, omitted);
    else countable.push(file);
  });
  if (countable.length > 0) {
    const [counts = ""] = await intentToAdd(cwd, countable, [[...NUMSTAT, "--no-renames"]]);
    for (const [file, body] of numstat(counts)) bodies.set(file, body);
  }
  return files.flatMap((file, index) => {
    const body = bodies.get(file) ?? (stats[index] ? noLines : null);
    return body ? [{ path: file, status: "untracked" as const, oldPath: null, body }] : [];
  });
}

/**
 * Runs each git command against a throwaway index holding only `files`, marked intent-to-add, so a plain `git diff`
 * shows them as new files against nothing. Files that vanished before `git add` are dropped and the add tried again.
 */
async function intentToAdd(cwd: string, files: string[], reads: string[][]): Promise<string[]> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openorc-untracked-"));
  const env = { ...LITERAL, GIT_INDEX_FILE: path.join(dir, "index") };
  const add = (list: string[]) => git(cwd, [...INDEX_CONFIG, "add", "--intent-to-add", "--pathspec-from-file=-", "--pathspec-file-nul"], { env, input: list.join("\0") });
  try {
    await add(files).catch(async (error: unknown) => {
      if (!(error instanceof GitError)) throw error;
      const present = await Promise.all(
        files.map((file) =>
          lstat(path.join(cwd, file)).then(
            () => file,
            () => null,
          ),
        ),
      );
      const left = present.filter((file) => file !== null);
      if (left.length > 0) await add(left);
    });
    return await Promise.all(reads.map(async (args) => (await git(cwd, [...INDEX_CONFIG, ...args], { env, okCodes: [0, 1] })).stdout));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The patch from its first hunk on, without git's header lines, then cut to size. A binary file has no hunks. */
function fileDiff(change: FileChange, body: FileDiffBody, patch: string): FileDiff {
  const at = patch.startsWith("@@") ? 0 : patch.indexOf("\n@@");
  const hunks = body.kind !== "text" || at === -1 ? "" : patch.slice(at === 0 ? 0 : at + 1);
  return { path: change.path, oldPath: change.oldPath, status: change.status, body, ...cutPatch(hunks) };
}

/** Whole lines up to FILE_DIFF_LINES and FILE_DIFF_BYTES, and how many of how many when that is not all of them. */
function cutPatch(patch: string): Pick<FileDiff, "patch" | "cut"> {
  if (patch === "") return { patch, cut: null };
  const lines = (patch.endsWith("\n") ? patch.slice(0, -1) : patch).split("\n");
  let bytes = 0;
  let shown = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line) + 1;
    if (shown === FILE_DIFF_LINES || bytes + size > FILE_DIFF_BYTES) break;
    bytes += size;
    shown += 1;
  }
  if (shown === lines.length) return { patch, cut: null };
  return { patch: lines.slice(0, shown).join("\n") + "\n", cut: { shownLines: shown, totalLines: lines.length } };
}
