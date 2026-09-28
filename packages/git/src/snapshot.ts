import { copyFile, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DiffStat } from "@openorc/protocol";
import { git } from "./exec.js";
import { headOrEmptyTree } from "./repo.js";

/** A throwaway index must not write split-index files into .git or share the real index's fsmonitor and untracked caches. */
const THROWAWAY_INDEX = ["-c", "core.splitIndex=false", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"];

/**
 * Runs `use` against a throwaway index holding HEAD (or nothing, before the first commit) plus every working-tree
 * change, untracked files included.
 * The index starts as a copy of the real one, so unchanged files keep their cached stats and are not re-read.
 */
async function withWorkingTreeIndex<T>(cwd: string, use: (run: (args: string[], okCodes?: number[]) => Promise<string>) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openorc-index-"));
  const indexFile = path.join(dir, "index");
  const run = async (args: string[], okCodes?: number[]) => (await git(cwd, [...THROWAWAY_INDEX, ...args], { env: { GIT_INDEX_FILE: indexFile }, ...(okCodes ? { okCodes } : {}) })).stdout;
  try {
    const head = await headOrEmptyTree(cwd);
    if (!(await seedFromRealIndex(cwd, indexFile, run, head))) {
      await rm(indexFile, { force: true });
      await run(["read-tree", head]);
    }
    await run(["add", "-A"]);
    return await use(run);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Copies the real index and resets it to `tree`. False when that index cannot be trusted as a stat cache. */
async function seedFromRealIndex(cwd: string, indexFile: string, run: (args: string[]) => Promise<string>, tree: string): Promise<boolean> {
  try {
    const realIndex = (await git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).stdout.trim();
    // Git re-reads files changed in the same second as the index. Staying below the real index's time keeps that check.
    const seconds = Math.floor(((await stat(realIndex)).mtimeMs - 1) / 1000);
    if (seconds <= 0) return false;
    await copyFile(realIndex, indexFile);
    // Keeps cached stats only for entries whose content already matches the tree.
    await run(["read-tree", "--reset", tree]);
    await utimes(indexFile, seconds, seconds);
    // Assume-unchanged and skip-worktree entries (sparse checkouts included) would hide real changes from add -A.
    return !(await run(["ls-files", "-v", "-z"])).split("\0").some((entry) => /^[a-zS]/.test(entry));
  } catch {
    return false;
  }
}

/**
 * Hash of the whole working tree, untracked files included, without touching
 * the real index or making a commit.
 */
export function treeHash(cwd: string): Promise<string> {
  return withWorkingTreeIndex(cwd, async (run) => (await run(["write-tree"])).trim());
}

/**
 * Changes the working tree from `fromTree` to `toTree` the way Git checks files out, clean and smudge filters
 * included, through a throwaway index so the real index and its staged changes stay as they are. Git refuses and
 * changes nothing when a file it would replace or delete no longer matches `fromTree`, or when an untracked file is
 * in the way. Files neither tree names, such as ignored ones, are left alone.
 */
export async function switchFiles(cwd: string, fromTree: string, toTree: string): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openorc-switch-"));
  const indexFile = path.join(dir, "index");
  const run = async (args: string[], okCodes?: number[]) => (await git(cwd, [...THROWAWAY_INDEX, ...args], { env: { GIT_INDEX_FILE: indexFile }, ...(okCodes ? { okCodes } : {}) })).stdout;
  try {
    if (!(await seedFromRealIndex(cwd, indexFile, run, fromTree))) {
      await rm(indexFile, { force: true });
      await run(["read-tree", fromTree]);
    }
    // Git trusts an entry only once its stat data says the file still matches; changed files stay unmatched.
    await run(["update-index", "-q", "--refresh"], [0, 1]);
    await run(["read-tree", "-m", "-u", fromTree, toTree]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Everything that differs between a snapshot tree and the working tree now,
 * untracked files included. This is the "since your last review" diff.
 */
export function patchSinceTree(cwd: string, treeSha: string): Promise<string> {
  return withWorkingTreeIndex(cwd, (run) => run(["diff", "--cached", "--no-color", "--no-ext-diff", "-M", treeSha], [0, 1]));
}

export async function diffStat(cwd: string, baseSha: string | null): Promise<DiffStat> {
  const base = baseSha ?? (await headOrEmptyTree(cwd));
  const out = (await git(cwd, ["diff", "--shortstat", base], { okCodes: [0, 1] })).stdout;
  const files = Number(/(\d+) files? changed/.exec(out)?.[1] ?? 0);
  const insertions = Number(/(\d+) insertions?/.exec(out)?.[1] ?? 0);
  const deletions = Number(/(\d+) deletions?/.exec(out)?.[1] ?? 0);
  const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard"])).stdout.split("\n").filter(Boolean).length;
  return { files, insertions, deletions, untracked };
}
