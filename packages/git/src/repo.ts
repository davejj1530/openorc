import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Commit, FileChange, ProjectGit } from "@openorc/protocol";
import { git, GitError } from "./exec.js";

export interface RepoInfo {
  root: string;
  remoteUrl: string | null;
  defaultBranch: string | null;
  /** Null while the repository has no commits yet. */
  headSha: string | null;
  branch: string | null;
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await git(dir, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * What git offers a folder. Only a repository's top folder counts: a plain folder inside another
 * repository stays plain, so nothing OpenOrc does there reaches the outer repository.
 */
export async function gitState(dir: string): Promise<ProjectGit> {
  const prefix = await git(dir, ["rev-parse", "--show-prefix"]).catch((error: unknown) => {
    // Anything else, such as a missing folder, is a real failure for the caller to report.
    if (error instanceof GitError && error.stderr.includes("not a git repository")) return null;
    throw error;
  });
  if (prefix?.stdout.trim() !== "") return "none";
  return (await headCommit(dir)) ? "ready" : "no_commits";
}

/** HEAD's commit, or null while the repository has no commits yet. */
export async function headCommit(cwd: string): Promise<string | null> {
  return (await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { okCodes: [0, 1] })).stdout.trim() || null;
}

/** What a diff without a base compares against: HEAD, or the empty tree before the first commit. */
export async function headOrEmptyTree(cwd: string): Promise<string> {
  return (await headCommit(cwd)) ?? (await git(cwd, ["hash-object", "-t", "tree", "--stdin"], { input: "" })).stdout.trim();
}

export async function repoInfo(dir: string): Promise<RepoInfo> {
  const root = (await git(dir, ["rev-parse", "--show-toplevel"])).stdout.trim();
  const headSha = await headCommit(root);
  // Names the branch before its first commit too; a detached HEAD has none.
  const branch = (await git(root, ["symbolic-ref", "--short", "--quiet", "HEAD"], { okCodes: [0, 1] })).stdout.trim() || null;
  let remoteUrl: string | null = null;
  try {
    remoteUrl = (await git(root, ["remote", "get-url", "origin"])).stdout.trim() || null;
  } catch {
    remoteUrl = null;
  }
  return { root, remoteUrl, defaultBranch: await defaultBranch(root), headSha, branch };
}

/** origin/HEAD if it is set, else the first of main or master that exists, else the current branch. */
export async function defaultBranch(root: string): Promise<string | null> {
  try {
    const ref = (await git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).stdout.trim();
    if (ref.startsWith("origin/")) return ref.slice("origin/".length);
  } catch {
    // no origin/HEAD
  }
  for (const candidate of ["main", "master"]) {
    try {
      await git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
      return candidate;
    } catch {
      // not this one
    }
  }
  try {
    const b = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    return b === "HEAD" ? null : b;
  } catch {
    return null;
  }
}

export async function fetch(root: string, remote = "origin", ref?: string, timeoutMs = 20_000): Promise<boolean> {
  try {
    await git(root, ref ? ["fetch", remote, ref] : ["fetch", remote], { timeoutMs });
    return true;
  } catch (e) {
    if (e instanceof GitError) return false;
    throw e;
  }
}

export async function revParse(cwd: string, ref: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim();
}

/** Changed files versus a base commit, plus untracked files. */
export async function changedFiles(cwd: string, baseSha: string | null): Promise<FileChange[]> {
  const out: FileChange[] = [];
  const tracked = (await git(cwd, ["diff", "--name-status", "-z", "-M", baseSha ?? (await headOrEmptyTree(cwd))])).stdout;
  const parts = tracked.split("\0");
  for (let i = 0; i < parts.length;) {
    const code = parts[i];
    if (!code) break;
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const oldPath = parts[i + 1] ?? "";
      const newPath = parts[i + 2] ?? "";
      out.push({ path: newPath, status: "renamed", oldPath });
      i += 3;
    } else {
      const p = parts[i + 1] ?? "";
      out.push({ path: p, status: changedFileStatus(letter), oldPath: null });
      i += 2;
    }
  }
  const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout.split("\0").filter(Boolean);
  for (const p of untracked) out.push({ path: p, status: "untracked", oldPath: null });
  return out;
}

const MAX_UNTRACKED_DIFF_BYTES = 1024 * 1024;

/**
 * A unified patch of everything that differs from the base: tracked changes
 * in the working tree (staged or not) plus untracked files rendered as adds.
 */
export async function patchAgainst(cwd: string, baseSha: string | null): Promise<string> {
  const parts: string[] = [];
  const base = baseSha ?? (await headOrEmptyTree(cwd));
  parts.push((await git(cwd, ["diff", "--no-color", "--no-ext-diff", "-M", base], { okCodes: [0, 1] })).stdout);
  const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout.split("\0").filter(Boolean);
  const renderable: string[] = [];
  const placeholders: string[] = [];
  for (const file of untracked) {
    const s = await stat(path.join(cwd, file)).catch(() => null);
    if (!s) continue;
    if (s.isFile() && s.size <= MAX_UNTRACKED_DIFF_BYTES) renderable.push(file);
    else placeholders.push(`diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+[${s.isFile() ? "large file omitted" : "not a regular file"}]\n`);
  }
  parts.push(await untrackedPatch(cwd, renderable).catch((e: unknown) => (e instanceof GitError ? untrackedPatchPerFile(cwd, renderable) : Promise.reject(e))), ...placeholders);
  return parts.filter((p) => p.trim().length > 0).join("\n");
}

/**
 * Untracked files rendered as new-file patches in one git call: they are marked intent-to-add in a throwaway index,
 * so `git diff` shows them against nothing. Renames stay off so each file stays its own add, as with one diff per file.
 */
async function untrackedPatch(cwd: string, files: string[]): Promise<string> {
  if (files.length === 0) return "";
  const dir = await mkdtemp(path.join(os.tmpdir(), "openorc-untracked-"));
  const env = { GIT_INDEX_FILE: path.join(dir, "index"), GIT_LITERAL_PATHSPECS: "1" };
  // filemode=true keeps an executable's mode even where the repository ignores modes, as `diff --no-index` did.
  const config = ["-c", "core.splitIndex=false", "-c", "core.fsmonitor=false", "-c", "core.filemode=true"];
  try {
    await git(cwd, [...config, "add", "--intent-to-add", "--pathspec-from-file=-", "--pathspec-file-nul"], { env, input: files.join("\0") });
    return (await git(cwd, [...config, "diff", "--no-color", "--no-ext-diff", "--no-renames"], { env, okCodes: [0, 1] })).stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** One `diff --no-index` per file: slower, but survives a file vanishing between listing and diffing. */
async function untrackedPatchPerFile(cwd: string, files: string[]): Promise<string> {
  const parts: string[] = [];
  for (const file of files) {
    try {
      const r = await git(cwd, ["diff", "--no-color", "--no-index", "--", "/dev/null", file], { okCodes: [0, 1] });
      // git prefixes with the absolute-ish path; normalise the header to the repo-relative one.
      parts.push(r.stdout.replace(/^diff --git a\/dev\/null b\/.*$/m, `diff --git a/${file} b/${file}`).replace(/^\+\+\+ b\/.*$/m, `+++ b/${file}`));
    } catch (e) {
      if (!(e instanceof GitError)) throw e;
    }
  }
  return parts.join("");
}

export async function log(cwd: string, range: string | null, limit = 50): Promise<Commit[]> {
  if (!range && !(await headCommit(cwd))) return [];
  const args = ["log", `--max-count=${limit}`, "--format=%H%x1f%an%x1f%at%x1f%s"];
  if (range) args.push(range);
  const out = (await git(cwd, args)).stdout;
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", author = "", at = "0", subject = ""] = line.split("\x1f");
      return { sha, author, at: Number(at) * 1000, subject };
    });
}

export async function isDirty(cwd: string): Promise<boolean> {
  const out = (await git(cwd, ["status", "--porcelain"])).stdout;
  return out.trim().length > 0;
}

function changedFileStatus(letter: string | undefined): FileChange["status"] {
  if (letter === "A") return "added";
  if (letter === "D") return "deleted";
  return "modified";
}
