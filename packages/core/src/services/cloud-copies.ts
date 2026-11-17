/**
 * A cloud thread's code to read on this computer without moving the thread and without waking its machine: a copy of
 * its newest work save (git's `makeReadingCopy`), kept per thread under OpenOrc's data folder and made again only when
 * the save moves on. The file explorer reads a cloud thread's files from it, and Open on this computer shows it.
 *
 * It shows the save, not anything newer: a turn's recorded changes are patches against that turn's own start, cut when
 * large, so laying them over a save could show files that never were. Someone who wants it newer asks the machine for a
 * save and passes `after` (the save they had); a write the person made lands at once (`applyWrite`) until the next save
 * catches up.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projects, type Db } from "@openorc/db";
import { makeReadingCopy } from "@openorc/git";
import type { Hosted } from "@openorc/hosted";
import type { CloudCopy, ComputerNames } from "@openorc/protocol";

export interface CloudCopiesDeps {
  db: Db;
  hosted: () => Hosted | null;
  /** OpenOrc's data folder; copies live in its `cloud-copies`. */
  dataDir: string;
  /** Tells every window its files changed, as a save from the editor does. */
  invalidate: (keys: string[]) => void;
  here: ComputerNames;
  now?: () => number;
}

/** How long a copy asked for a save newer than one it had waits for the machine to leave with it. */
const NEWER_MS = 60_000;
/** Where a copy keeps what it was made from, inside its own git folder, out of its files. */
const MADE_FROM = path.join(".git", "openorc-reading-copy.json");

export class CloudCopies {
  private readonly making = new Map<string, Promise<CloudCopy>>();

  constructor(private readonly deps: CloudCopiesDeps) {}

  /** The thread's copy folder, whether or not it is made yet. */
  folderOf(threadId: string): string {
    return path.join(this.deps.dataDir, "cloud-copies", threadId);
  }

  /**
   * The thread's reading copy, made again only when its newest save moved on. With `after`, waits until there is a save
   * newer than that one first. Reads asked at once share one making.
   */
  ensure(threadId: string, options: { after?: string } = {}): Promise<CloudCopy> {
    const under = this.making.get(threadId);
    if (under && !options.after) return under;
    const made = (under ?? Promise.resolve()).catch(() => undefined).then(() => this.make(threadId, options.after));
    const kept = made.finally(() => {
      if (this.making.get(threadId) === kept) this.making.delete(threadId);
    });
    this.making.set(threadId, kept);
    return kept;
  }

  /**
   * A file the person wrote on the thread's machine, laid into the copy at once (null: deleted), so what they are shown
   * is never older than what they wrote. The next save makes the copy again.
   */
  async applyWrite(threadId: string, file: string, bytes: Uint8Array | null): Promise<void> {
    await this.making.get(threadId)?.catch(() => undefined);
    const folder = this.folderOf(threadId);
    const made = await this.madeFrom(folder);
    if (!made) return;
    const at = path.resolve(folder, file);
    if (!at.startsWith(folder + path.sep) || at.startsWith(path.join(folder, ".git") + path.sep)) throw new Error("That file isn't in the thread's folder.");
    if (bytes) {
      await mkdir(path.dirname(at), { recursive: true });
      await writeFile(at, bytes);
    } else await rm(at, { force: true });
    await this.keep(folder, { ...made, asOf: { turnId: null, at: new Date(this.now()).toISOString() } });
    this.deps.invalidate(["files", "workspace-diff"]);
  }

  /** Lets the thread's copy go: the thread is gone, or this computer may no longer read it. */
  async forget(threadId: string): Promise<void> {
    await this.making.get(threadId)?.catch(() => undefined);
    await rm(this.folderOf(threadId), { recursive: true, force: true });
  }

  private async make(threadId: string, after: string | undefined): Promise<CloudCopy> {
    const hosted = this.deps.hosted();
    if (!hosted?.threads.holds({ thread: threadId })) throw new Error("That conversation isn't on OpenOrc Cloud.");
    const space = hosted.threads.row!(threadId).space;
    const save = await this.newestSave(hosted, space, threadId, after);
    const folder = this.folderOf(threadId);
    const made = await this.madeFrom(folder);
    if (made && made.savedAt === save.savedAt && made.head === save.head) return made;
    const summary = hosted.threads.summary?.(threadId);
    const project = summary ? projects.get(this.deps.db, summary.projectId) : null;
    if (!project) throw new Error(`This project isn't on ${this.deps.here.thisComputer}.`);
    await mkdir(path.dirname(folder), { recursive: true });
    const temp = await mkdtemp(path.join(os.tmpdir(), "openorc-copy-"));
    try {
      let bundle: string | null = null;
      if (save.bundle) {
        const response = await hosted.macProjects.bundle(space, threadId, AbortSignal.timeout(NEWER_MS));
        if (!response.ok) throw new Error(`OpenOrc Cloud didn't give the thread's saved work (${response.status}).`);
        bundle = path.join(temp, "work.bundle");
        await writeFile(bundle, Buffer.from(await response.arrayBuffer()));
      }
      await makeReadingCopy(project.rootPath, folder, save, bundle);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
    const copy: CloudCopy = { folder, savedAt: save.savedAt, head: save.head, asOf: { turnId: null, at: save.savedAt } };
    await this.keep(folder, copy);
    this.deps.invalidate(["files", "workspace-diff"]);
    return copy;
  }

  /** The thread's newest save; with `after`, the first one newer than that, waited for a while. */
  private async newestSave(hosted: Hosted, space: string, threadId: string, after: string | undefined) {
    const until = this.now() + NEWER_MS;
    for (;;) {
      const { save } = await hosted.macProjects.workSave(space, threadId);
      if (save && (!after || Date.parse(save.savedAt) > Date.parse(after))) return save;
      if (!after) throw new Error("This thread has no saved work yet.");
      if (this.now() > until) throw new Error("The thread didn't leave its cloud machine in time. Try again.");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  private async madeFrom(folder: string): Promise<CloudCopy | null> {
    if (!(await stat(folder).catch(() => null))) return null;
    try {
      return JSON.parse(await readFile(path.join(folder, MADE_FROM), "utf8")) as CloudCopy;
    } catch {
      return null;
    }
  }

  private async keep(folder: string, copy: CloudCopy): Promise<void> {
    await writeFile(path.join(folder, MADE_FROM), JSON.stringify(copy));
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}
