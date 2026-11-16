import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git } from "./exec.js";
import { MAC_FILE_BYTES, MAC_WORK_BYTES } from "./mac-start.js";

/*
 * A folder of this Mac with no GitHub remote, made a Personal cloud project: its history goes up once as the project's
 * origin, a git bundle of its current branch with no prerequisite. And the way back: a cloud thread's commits brought
 * into the folder as a branch, never touching its working tree, its index or the branch checked out.
 */

const sizeWords = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`);

/** What the folder's history would send, or why it can't go. */
export type MacHistory = { branch: string; head: string; bytes: number; refusal: string | null };

/** The history packed: a bundle at `file`, in a folder of its own for the caller to remove. */
export type MacHistoryPack = MacHistory & { file: string };

/** Why the history of `name` can't go: a file in it over MAC_FILE_BYTES, named, or the whole over MAC_WORK_BYTES. */
function refusalOf(name: string, bytes: number, largest: { path: string; bytes: number } | null): string | null {
  if (largest && largest.bytes > MAC_FILE_BYTES) return `Too large to send from this Mac: ${largest.path} (${sizeWords(largest.bytes)}) in its history, over ${sizeWords(MAC_FILE_BYTES)} each.`;
  if (bytes > MAC_WORK_BYTES) return `${name} is ${sizeWords(bytes)} with its history, over ${sizeWords(MAC_WORK_BYTES)}.`;
  return null;
}

/**
 * What the folder's history would send: its branch, its head, how much it weighs packed and why it can't go, checked
 * before anything is made. Throws in words when the folder has no branch checked out.
 */
export async function macHistory(folder: string, name: string): Promise<MacHistory> {
  const branch = (await git(folder, ["symbolic-ref", "--quiet", "--short", "HEAD"], { okCodes: [0, 1, 128] })).stdout.trim();
  if (!branch) throw new Error("Check out a branch in this folder first.");
  const head = (await git(folder, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
  const objects = (await git(folder, ["rev-list", "--objects", "HEAD"])).stdout.split("\n").filter(Boolean);
  const paths = new Map(objects.map((line) => [line.slice(0, line.indexOf(" ") > 0 ? line.indexOf(" ") : undefined), line.indexOf(" ") > 0 ? line.slice(line.indexOf(" ") + 1) : ""]));
  const sized = (await git(folder, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize) %(objectsize:disk)"], { input: [...paths.keys()].join("\n") + "\n" })).stdout.split("\n");
  let bytes = 0;
  let largest: { path: string; bytes: number } | null = null;
  for (const line of sized) {
    const [oid = "", type, size, disk] = line.split(" ");
    if (!type) continue;
    bytes += Number(disk);
    const file = paths.get(oid);
    if (type === "blob" && file && Number(size) > (largest?.bytes ?? -1)) largest = { path: file, bytes: Number(size) };
  }
  return { branch, head, bytes, refusal: refusalOf(name, bytes, largest) };
}

/** Packs the folder's history, when it can go, into a bundle of its branch alone; the folder itself is not touched. */
export async function packMacHistory(folder: string, name: string): Promise<MacHistoryPack | MacHistory> {
  const history = await macHistory(folder, name);
  if (history.refusal) return history;
  const dir = await mkdtemp(path.join(os.tmpdir(), "openorc-history-"));
  const file = path.join(dir, "origin.bundle");
  try {
    await git(folder, ["bundle", "create", "-q", file, `refs/heads/${history.branch}`]);
    const bytes = (await stat(file)).size;
    const refusal = refusalOf(name, bytes, null);
    if (refusal) {
      await rm(dir, { recursive: true, force: true });
      return { ...history, bytes, refusal };
    }
    return { ...history, bytes, file };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

/** A thread's work that can't come into this folder, in the person's words. */
export class BringRefused extends Error {}

export const NOT_THAT_FOLDER = "This folder doesn't hold this thread's history, so its work can't come here.";

/** Where a bring's refs wait in the folder while it is checked, removed after. */
const WAITING = "refs/openorc/bring/";

/**
 * Brings a thread's commits from its save's bundle into `folder` as a branch: its objects fetched with every one
 * checked, then `refs/heads/<branch>` made, or moved forward only. A branch of that name that has commits the thread
 * lacks, or that is checked out, is left alone, and the work comes as `<branch>-2` and on. The working tree, the index
 * and the branch checked out are never touched. Answers the branch it is on and how many commits came.
 */
export async function bringIntoFolder(folder: string, bundle: string, save: { branch: string | null; head: string; base: string }): Promise<{ branch: string; commits: number }> {
  const quiet = { okCodes: [0, 1, 128] };
  if ((await git(folder, ["cat-file", "-e", `${save.base}^{commit}`], quiet)).code !== 0) throw new BringRefused(NOT_THAT_FOLDER);
  if ((await git(folder, ["bundle", "verify", "-q", bundle], quiet)).code !== 0) throw new BringRefused("The thread's saved work didn't arrive whole. Try again.");
  const wanted = save.branch ?? `openorc/${save.head.slice(0, 7)}`;
  // A name git could read as an option, or that is no branch's, is never passed on.
  const checked = wanted.startsWith("-") ? "" : (await git(folder, ["check-ref-format", "--branch", wanted], quiet)).stdout.trim();
  const base = checked && checked === wanted ? wanted : `openorc/${save.head.slice(0, 7)}`;
  try {
    await git(folder, ["-c", "transfer.fsckObjects=true", "-c", "fetch.fsckObjects=true", "fetch", "-q", "--no-tags", "--no-write-fetch-head", bundle, `+refs/*:${WAITING}*`]);
    if ((await git(folder, ["cat-file", "-e", `${save.head}^{commit}`], quiet)).code !== 0) throw new BringRefused("The thread's saved work didn't hold its newest commit. Try again.");
    const current = (await git(folder, ["symbolic-ref", "--quiet", "HEAD"], quiet)).stdout.trim();
    for (let at = 1; at <= 9; at++) {
      const name = at === 1 ? base : `${base}-${at}`;
      const ref = `refs/heads/${name}`;
      if (ref === current) continue;
      const had = (await git(folder, ["rev-parse", "--verify", "--quiet", ref], quiet)).stdout.trim();
      if (had === save.head) return { branch: name, commits: 0 };
      const forward = !had || (await git(folder, ["merge-base", "--is-ancestor", had, save.head], quiet)).code === 0;
      if (!forward) continue;
      await git(folder, ["update-ref", ref, save.head, had || "0".repeat(save.head.length)]);
      const commits = Number((await git(folder, ["rev-list", "--count", save.head, `^${had || save.base}`])).stdout.trim());
      return { branch: name, commits };
    }
    throw new BringRefused(`This folder already has branches named ${base} with other work. Rename one, then bring it again.`);
  } finally {
    const waiting = (await git(folder, ["for-each-ref", "--format=%(refname)", WAITING], quiet)).stdout.split("\n").filter(Boolean);
    for (const ref of waiting) await git(folder, ["update-ref", "-d", ref], quiet);
  }
}
