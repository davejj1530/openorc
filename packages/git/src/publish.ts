import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { git, run, GitError } from "./exec.js";

export async function commitAll(cwd: string, message: string): Promise<string> {
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-m", message]);
  return (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
}

export async function push(cwd: string, branch: string, remote = "origin"): Promise<void> {
  try {
    await git(cwd, ["push", "-u", remote, branch], { timeoutMs: 120_000 });
  } catch (e) {
    // Git's own report is a page of hints; the remedy is one sentence.
    if (e instanceof GitError && /\[rejected\].*\((fetch first|non-fast-forward)\)/.test(e.stderr)) throw new Error(`${remote} has newer commits on ${branch}. Pull them in first, then push again.`);
    throw e;
  }
}

export interface UnpushedCommits {
  /** Whether the remote already has the branch. */
  published: boolean;
  /** How many commits no branch on the remote has yet. */
  count: number;
  /** The newest of those commits, up to the limit. */
  shas: string[];
}

/**
 * What pushing `rev` to `branch` would send, judged by the remote-tracking refs the last
 * fetch or push left, so it never touches the network. A commit counts as pushed once any
 * branch on the remote has it. Null when the repository has no such remote.
 */
export async function unpushedCommits(cwd: string, options: { rev: string; branch: string; remote?: string; limit?: number }): Promise<UnpushedCommits | null> {
  const { rev, branch, remote = "origin", limit = 200 } = options;
  const configured = await git(cwd, ["remote", "get-url", remote], { okCodes: [0, 2] });
  if (configured.code !== 0) return null;
  const range = [rev, "--not", `--remotes=${remote}`];
  const [tracking, count, shas] = await Promise.all([
    git(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`], { okCodes: [0, 1] }),
    git(cwd, ["rev-list", "--count", ...range]),
    git(cwd, ["rev-list", `--max-count=${limit}`, ...range]),
  ]);
  return { published: tracking.code === 0, count: Number(count.stdout.trim()), shas: shas.stdout.split("\n").filter(Boolean) };
}

export async function hasGh(): Promise<boolean> {
  try {
    await run("gh", process.cwd(), ["--version"], { timeoutMs: 5000 });
    return true;
  } catch {
    return false;
  }
}

const templateName = /^pull[_-]request[_-]template(\.|$)/i;
/** A leading YAML block, which gh drops before using a template. */
const frontMatter = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * The repository's default pull request template, found where `gh pr create` looks: a file named
 * pull_request_template (any case, `_` or `-`, any extension) in `.github`, the root, then `docs`.
 * Null when there is none.
 */
export async function pullRequestTemplate(cwd: string): Promise<string | null> {
  for (const dir of [path.join(cwd, ".github"), cwd, path.join(cwd, "docs")]) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const names = entries.filter((entry) => !entry.isDirectory() && templateName.test(entry.name)).map((entry) => entry.name);
    const name = names.sort()[0];
    if (name) return (await readFile(path.join(dir, name), "utf8")).replace(frontMatter, "");
  }
  return null;
}

/** Opens a pull request with the user's own gh login. Returns the PR URL. */
export async function createPr(cwd: string, options: { title: string; body: string; base: string; head: string }): Promise<string> {
  try {
    const r = await run("gh", cwd, ["pr", "create", "--title", options.title, "--body", options.body, "--base", options.base, "--head", options.head], { timeoutMs: 60_000 });
    const url = r.stdout.trim().split("\n").pop() ?? "";
    return url;
  } catch (e) {
    if (e instanceof GitError) throw new Error(`gh pr create failed: ${e.stderr.trim()}`);
    throw e;
  }
}
