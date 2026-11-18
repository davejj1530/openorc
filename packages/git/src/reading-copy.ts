import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { git, GitError } from "./exec.js";

const QUIET = { okCodes: [0, 1, 128] };
const HELD = "refs/saved/";
/** How long a start's fetch may go without a byte from the repository before it is called out of reach. */
const STALLED_S = 20;
/** How long this computer's git may take to give its sign-in for a repository, as a locked keychain may keep it. */
const SIGN_IN_MS = 30_000;
/**
 * The only credential helper a start's fetch has: it gives the sign-in read for it, from its own environment, and never
 * keeps one. Git keeps a sign-in it used with every helper the person has, which may wait on their keychain after the
 * fetch is done.
 */
const GIVE_ONLY = `!f() { if [ "$1" = get ]; then printf 'username=%s\\npassword=%s\\n' "$OPENORC_START_USERNAME" "$OPENORC_START_PASSWORD"; fi; }; f`;

/** The project's folder here doesn't hold the commit the thread started from, and its remote didn't give it. */
export const START_NOT_HERE = "This project's folder doesn't hold the commit the thread started from. Pull it, then try again.";

/**
 * Where a copy finds the commit a save started from: the project's folder here, or, for a project with no folder here,
 * OpenOrc's own store of starts, fetched from the project's repository with this computer's own sign-in to it.
 */
export type ReadingStart = { folder: string } | { store: string; remote: string };

/** Why a start could not be fetched from the project's repository: `offline` alone may go by trying again. */
export type StartMissing = "offline" | "access" | "gone";

/** The project's repository didn't give the commit a save started from. */
export class StartUnreachable extends Error {
  constructor(readonly reason: StartMissing) {
    super(`The commit the thread started from couldn't be fetched (${reason}).`);
    this.name = "StartUnreachable";
  }
}

/**
 * A copy of a cloud thread's newest work save, to read on this computer and never written back. It reads its objects
 * from where its start is, sharing them, with the save's commits fetched from its bundle (one that has none is its start
 * as it was). Its files are checked out as the save left them, what it hadn't committed included, on the save's newest
 * commit, so `git status` there reads as it did on the thread's machine. Made beside `to` and put in place whole, so a
 * reader never sees half a copy.
 */
export async function makeReadingCopy(start: ReadingStart, to: string, save: { head: string; base: string }, bundle: string | null): Promise<void> {
  const from = "folder" in start ? await startInFolder(start.folder, save.base) : await startInStore(start.store, start.remote, save.base);
  const making = `${to}.making-${randomUUID()}`;
  try {
    await git(path.dirname(to), ["init", "-q", making]);
    await writeFile(path.join(making, ".git", "objects", "info", "alternates"), `${path.join(from, "objects")}\n`);
    // A start fetched alone has no parents here; the copy knows where its history stops, as its store does.
    await copyFile(path.join(from, "shallow"), path.join(making, ".git", "shallow")).catch(() => undefined);
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

/** The project folder's git folder, once it holds `base`, fetched from its remote when it didn't. */
async function startInFolder(folder: string, base: string): Promise<string> {
  if (!(await holds(folder, base))) await git(folder, ["fetch", "-q", "--no-tags", "--no-write-fetch-head", "origin", base], QUIET);
  if (!(await holds(folder, base))) throw new Error(START_NOT_HERE);
  return (await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
}

/** Starts fetched into one store at once, so two copies of one repository never fetch over each other. */
const fetching = new Map<string, Promise<unknown>>();

/**
 * The store, once it holds `base`: only that commit and its files, fetched from `remote` when it didn't, and kept by a
 * ref of its own so the store never lets it go.
 */
async function startInStore(store: string, remote: string, base: string): Promise<string> {
  const before = fetching.get(store) ?? Promise.resolve();
  const fetched = before
    .catch(() => undefined)
    .then(async () => {
      if (!(await stat(path.join(store, "HEAD")).catch(() => null))) {
        await mkdir(store, { recursive: true });
        await git(store, ["init", "-q", "--bare"]);
      }
      if (await holds(store, base)) return;
      // A repository that answers nothing for STALLED_S is out of reach; one that sends, however large, may take its time.
      const stalled = ["-c", "http.lowSpeedLimit=1", "-c", `http.lowSpeedTime=${STALLED_S}`];
      const signIn = await signInFor(store, remote);
      const helpers = ["-c", "credential.helper=", ...(signIn ? ["-c", `credential.helper=${GIVE_ONLY}`] : [])];
      const env = signIn ? { OPENORC_START_USERNAME: signIn.username, OPENORC_START_PASSWORD: signIn.password } : {};
      const args = [...stalled, ...helpers, "fetch", "-q", "--depth=1", "--no-tags", "--no-write-fetch-head", remote, base];
      const answer = await git(store, args, { ...QUIET, env, timeoutMs: 10 * 60_000 }).catch((error: unknown) => {
        if (error instanceof GitError) return { code: error.code ?? -1, stderr: error.stderr };
        throw error;
      });
      if (!(await holds(store, base))) throw new StartUnreachable(missing(answer.stderr));
      await git(store, ["update-ref", `refs/starts/${base}`, base]);
    });
  fetching.set(store, fetched);
  try {
    await fetched;
  } finally {
    if (fetching.get(store) === fetched) fetching.delete(store);
  }
  return store;
}

/** The sign-in this computer's git has for `remote`, read and never written back; null for none, or none in time. */
async function signInFor(cwd: string, remote: string): Promise<{ username: string; password: string } | null> {
  const filled = await git(cwd, ["credential", "fill"], { input: `url=${remote}\n\n`, timeoutMs: SIGN_IN_MS, okCodes: [0, 128] }).catch(() => null);
  if (filled?.code !== 0) return null;
  const said = new Map(filled.stdout.split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const));
  const username = said.get("username");
  const password = said.get("password");
  return username && password ? { username, password } : null;
}

/** What a failed fetch's words say of why: a repository that may not be read, a commit it no longer has, or no way to reach it. */
function missing(stderr: string): StartMissing {
  if (/repository .*not found|authentication failed|could not read (username|password)|terminal prompts disabled|permission denied|\b40[13]\b/i.test(stderr)) return "access";
  if (/not our ref|no such remote ref|couldn't find remote ref|upload-pack: not our ref|unadvertised object/i.test(stderr)) return "gone";
  return "offline";
}

async function holds(folder: string, commit: string): Promise<boolean> {
  return (await git(folder, ["cat-file", "-e", `${commit}^{commit}`], QUIET)).code === 0;
}
