import { randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import path from "node:path";
import { git } from "./exec.js";

const QUIET = { okCodes: [0, 1, 128] };
const HELD = "refs/saved/";

/** The project's folder here doesn't hold the commit the thread started from, and its remote didn't give it. */
export const START_NOT_HERE = "This project's folder doesn't hold the commit the thread started from. Pull it, then try again.";

/**
 * A copy of a cloud thread's newest work save, to read on this computer and never written back. It is a clone of the
 * project's folder sharing its objects, with the save's commits fetched from its bundle (one that has none is its start
 * as it was). Its files are checked out as the save left them, what it hadn't committed included, on the save's newest
 * commit, so `git status` there reads as it did on the thread's machine. Made beside `to` and put in place whole, so a
 * reader never sees half a copy.
 */
export async function makeReadingCopy(project: string, to: string, save: { head: string; base: string }, bundle: string | null): Promise<void> {
  if (!(await holds(project, save.base))) await git(project, ["fetch", "-q", "--no-tags", "--no-write-fetch-head", "origin", save.base], QUIET);
  if (!(await holds(project, save.base))) throw new Error(START_NOT_HERE);
  const making = `${to}.making-${randomUUID()}`;
  try {
    await git(path.dirname(to), ["clone", "-q", "--shared", "--no-checkout", project, making]);
    let files = save.head;
    if (bundle) {
      if ((await git(making, ["bundle", "verify", "-q", bundle], QUIET)).code !== 0) throw new Error("The thread's saved work didn't arrive whole. Try again.");
      await git(making, ["-c", "transfer.fsckObjects=true", "-c", "fetch.fsckObjects=true", "fetch", "-q", "--no-tags", "--no-write-fetch-head", bundle, `+refs/*:${HELD}*`]);
      if (!(await holds(making, save.head))) throw new Error("The thread's saved work didn't hold its newest commit. Try again.");
      files = (await git(making, ["rev-parse", "--verify", "--quiet", `${HELD}openorc/saved/wip`], QUIET)).stdout.trim() || save.head;
    }
    await git(making, ["-c", "advice.detachedHead=false", "checkout", "-q", "--detach", files]);
    // On its newest commit, with what it hadn't committed left in its files as changes.
    if (files !== save.head) await git(making, ["reset", "-q", save.head]);
    await rm(to, { recursive: true, force: true });
    await rename(making, to);
  } finally {
    await rm(making, { recursive: true, force: true });
  }
}

async function holds(folder: string, commit: string): Promise<boolean> {
  return (await git(folder, ["cat-file", "-e", `${commit}^{commit}`], QUIET)).code === 0;
}
