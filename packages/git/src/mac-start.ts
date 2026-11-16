import { lstat, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git } from "./exec.js";

/*
 * What a cloud thread started from this folder carries, decided here before anything leaves: the commits this folder
 * has that GitHub's copy of its base branch does not, and one commit of the folder's files on top (changed and new
 * ones; never what git ignores, and not the new files that look like secrets unless the person includes them). It is
 * packed as one git bundle in the layout the server's saves have: `refs/openorc/saved/wip` and the commits it needs
 * beyond `base`.
 */

/** The most the work may weigh, packed, as the server keeps a save's work. */
export const MAC_WORK_BYTES = 256 * 1024 * 1024;
/** The most one file may weigh. */
export const MAC_FILE_BYTES = 50 * 1024 * 1024;

/** New files held back unless the person includes them: they look like secrets. */
const HELD_BACK = /(^|\/)(\.env[^/]*|\.npmrc|\.netrc|\.pypirc|[^/]*\.(pem|key|p12|pfx|keystore|jks)|id_[^/]*|credentials[^/]*)$/i;

/** Whether a new file looks like a secret, so it stays here unless the person includes it. */
export const heldBack = (file: string): boolean => HELD_BACK.test(file);

const IDENTITY = { GIT_AUTHOR_NAME: "OpenOrc", GIT_AUTHOR_EMAIL: "cloud@openorc.app", GIT_COMMITTER_NAME: "OpenOrc", GIT_COMMITTER_EMAIL: "cloud@openorc.app" };
const THROWAWAY_INDEX = ["-c", "core.splitIndex=false", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"];

/** What the server is told of a pack: the commit it builds on, how the folder's checkout looks, and the files' commit. */
export type MacWorkQuery = { base: string; headSha: string; headTreeSha: string; treeSha: string; wip: string };

/** What leaves this folder, as the line before Start says it. `refusal` says why it can't go, naming the largest files. */
export interface MacWorkPlan {
  base: string;
  commits: { sha: string; subject: string }[];
  changed: string[];
  added: string[];
  /** New files that look like secrets and are not included. */
  held: string[];
  bytes: number;
  largest: { path: string; bytes: number }[];
  refusal: string | null;
}

/**
 * A plan with its pack, a bundle at `file` for the caller to send and remove (its folder with it). A plan refused for a
 * file's size before packing has none.
 */
export type MacWorkPack = MacWorkPlan & ({ file: string; query: MacWorkQuery } | { file: null; query: null });

const megabytes = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024 / 1024))} MB`;

/**
 * Packs the folder's work beyond `baseRef` (GitHub's copy of its base branch, such as `refs/remotes/origin/main`) into a
 * bundle in a folder of its own, with `include` naming the held-back files to send after all. The folder's own index,
 * HEAD and files are not touched. Throws in words when the folder shares no history with `baseRef`.
 */
export async function packMacWork(folder: string, options: { baseRef: string; include?: readonly string[] }): Promise<MacWorkPack> {
  const run = async (args: string[], env?: NodeJS.ProcessEnv) => (await git(folder, args, env ? { env } : {})).stdout;
  const base = (await git(folder, ["merge-base", "HEAD", options.baseRef], { okCodes: [0, 1, 128] })).stdout.trim();
  if (!base) throw new Error(`This folder shares no history with ${options.baseRef.replace(/^refs\/remotes\//, "")}. Fetch it, then try again.`);
  const headSha = (await run(["rev-parse", "HEAD"])).trim();
  const headTreeSha = (await run(["rev-parse", "HEAD^{tree}"])).trim();
  const commits = (await run(["log", "--format=%H%x00%s", `${base}..HEAD`]))
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", subject = ""] = line.split("\0");
      return { sha, subject };
    });
  const include = new Set(options.include ?? []);
  const changed: string[] = [];
  const added: string[] = [];
  const held: string[] = [];
  const status = (await run(["status", "--porcelain=v1", "-z", "-uall"])).split("\0").filter(Boolean);
  for (let at = 0; at < status.length; at++) {
    const entry = status[at]!;
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    if (code.startsWith("R") || code.startsWith("C")) at++;
    if (code !== "??") changed.push(file);
    else if (heldBack(file) && !include.has(file)) held.push(file);
    else added.push(file);
  }
  // A file too large is refused as it lies on disk, before anything of it is hashed or packed.
  const onDisk = await sizesOf(folder, [...changed, ...added]);
  if (onDisk.some((one) => one.bytes > MAC_FILE_BYTES)) {
    const refusal = refusalOf(0, onDisk);
    return { base, commits, changed, added, held, bytes: onDisk.reduce((sum, one) => sum + one.bytes, 0), largest: onDisk.slice(0, 5), refusal, file: null, query: null };
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "openorc-mac-work-"));
  const index = { GIT_INDEX_FILE: path.join(dir, "index") };
  try {
    await run([...THROWAWAY_INDEX, "read-tree", "HEAD"], index);
    // A held-back file is left out of the add itself, so nothing of it is written, even as a loose object.
    await run([...THROWAWAY_INDEX, "add", "-A", "--", ".", ...held.map((file) => `:(exclude,literal)${file}`)], index);
    const treeSha = (await run([...THROWAWAY_INDEX, "write-tree"], index)).trim();
    const wip = (await run(["commit-tree", treeSha, "-p", "HEAD", "-m", "OpenOrc work from the Mac"], IDENTITY)).trim();
    const largest = await largestFiles(folder, wip, base);
    const file = path.join(dir, "work.bundle");
    await run(["update-ref", "refs/openorc/saved/wip", wip]);
    try {
      await run(["bundle", "create", "-q", file, "refs/openorc/saved/wip", `^${base}`]);
    } finally {
      await run(["update-ref", "-d", "refs/openorc/saved/wip"]);
    }
    const bytes = (await stat(file)).size;
    const refusal = refusalOf(bytes, largest);
    return { base, commits, changed, added, held, bytes, largest: largest.slice(0, 5), refusal, file, query: { base, headSha, headTreeSha, treeSha, wip } };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Why a pack can't go: a file over MAC_FILE_BYTES, named, or the whole over MAC_WORK_BYTES, with its largest files. */
function refusalOf(bytes: number, largest: readonly { path: string; bytes: number }[]): string | null {
  const named = (files: readonly { path: string; bytes: number }[]) => files.map((one) => `${one.path} (${megabytes(one.bytes)})`).join(", ");
  const tooBig = largest.filter((one) => one.bytes > MAC_FILE_BYTES);
  if (tooBig.length) return `Too large to send from this Mac: ${named(tooBig)}, over ${megabytes(MAC_FILE_BYTES)} each.`;
  if (bytes > MAC_WORK_BYTES) return `Too much to send from this Mac: ${megabytes(bytes)}, over ${megabytes(MAC_WORK_BYTES)}. Largest: ${named(largest.slice(0, 3))}.`;
  return null;
}

/** The changed and new files' sizes as they lie in the folder, largest first; a file gone (deleted) has none. */
async function sizesOf(folder: string, files: readonly string[]): Promise<{ path: string; bytes: number }[]> {
  const sized = await Promise.all(files.map(async (file) => ({ path: file, bytes: (await lstat(path.join(folder, file)).catch(() => null))?.size ?? 0 })));
  return sized.sort((a, b) => b.bytes - a.bytes);
}

/** The files the pack carries beyond `base`, largest first: every blob of the commits and the files' commit, by path. */
async function largestFiles(folder: string, wip: string, base: string): Promise<{ path: string; bytes: number }[]> {
  const objects = (await git(folder, ["rev-list", "--objects", wip, `^${base}`])).stdout
    .split("\n")
    .map((line) => {
      const space = line.indexOf(" ");
      return space > 0 ? { oid: line.slice(0, space), path: line.slice(space + 1) } : null;
    })
    .filter((one): one is { oid: string; path: string } => Boolean(one?.path));
  if (!objects.length) return [];
  const sized = (await git(folder, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], { input: objects.map((one) => one.oid).join("\n") + "\n" })).stdout.split("\n");
  const sizes = new Map(
    sized.flatMap((line) => {
      const [oid = "", type, size] = line.split(" ");
      return type === "blob" ? [[oid, Number(size)] as const] : [];
    }),
  );
  const byPath = new Map<string, number>();
  for (const one of objects) {
    const bytes = sizes.get(one.oid);
    if (bytes !== undefined) byPath.set(one.path, Math.max(bytes, byPath.get(one.path) ?? 0));
  }
  return [...byPath].map(([file, bytes]) => ({ path: file, bytes })).sort((a, b) => b.bytes - a.bytes);
}
