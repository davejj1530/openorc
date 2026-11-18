/**
 * A cloud thread's files as this Mac's file browser reads them: the reading copy of the thread's newest work save
 * (CloudCopies). A read never asks anything of the machine and never waits on it: the copy is the last save, made again
 * when a newer save is there, and how old it is is the copy's own `asOf`, never passed off as live. Only the person's
 * Refresh has the machine leave with its newer work, and asks them first when that would end something running there.
 * (Asking on every read raced a turn starting: the machine left beneath it, and the turn was carried on as if lost.)
 */
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { projects } from "@openorc/db";
import { FileVersion, HOSTED_REASONS, type CloudCopy, type FileExpectation, type FileScope, type FileWriteResult, type FolderPath } from "@openorc/protocol";
import { CloudCopies, type CloudCopiesDeps } from "./cloud-copies.js";
import { conversationFolder, type ConversationFolder } from "./conversation-folder.js";

/** How long a copy is read as it is before its machine is asked again, so a listing's many reads ask once. */
const CHECK_MS = 30_000;
/** The `after` for a thread with no save yet: any save is newer. */
const NONE = new Date(0).toISOString();

export class CloudFolders {
  readonly copies: CloudCopies;
  /** When each thread's copy was last brought up to its machine. */
  private readonly checked = new Map<string, number>();
  /** Whether each thread's files may be written from here, as last asked of its server. */
  private readonly writable = new Map<string, { at: number; writes: boolean }>();
  private readonly deps: CloudCopiesDeps;

  constructor(deps: CloudCopiesDeps) {
    this.deps = deps;
    this.copies = new CloudCopies(deps);
  }

  /** Where a scope's files are: a cloud thread's copy, else its conversation's folder on this Mac. */
  of(scope: FileScope): Promise<ConversationFolder> {
    return scope.kind === "thread" && this.holds(scope.id) ? this.folder(scope.id) : conversationFolder(this.deps.db, scope);
  }

  /** Whether `threadId` is a cloud thread, whose files are read from its copy. */
  holds(threadId: string): boolean {
    return Boolean(this.deps.hosted()?.threads.holds({ thread: threadId }));
  }

  /** The thread's copy as a conversation's folder, brought up to its machine when it was not lately. */
  async folder(threadId: string): Promise<ConversationFolder> {
    const recent = this.now() - (this.checked.get(threadId) ?? -Infinity) < CHECK_MS;
    const folder = recent ? this.copies.folderOf(threadId) : (await this.read(threadId)).folder;
    const summary = this.deps.hosted()?.threads.summary?.(threadId);
    const project = summary ? projects.get(this.deps.db, summary.projectId) : null;
    if (!project) throw new Error("This thread's project isn't on this computer.");
    const readOnly = (await this.writes(threadId)) ? null : HOSTED_REASONS.fileWrite;
    return { root: await realpath(folder), kind: "cloud", project, readOnly, name: path.basename(project.rootPath) };
  }

  /**
   * Writes one file on the thread's machine, as its host makes it there while the file is still as `expected`, and lays
   * what the machine then has into the copy at once: the new text, or on a conflict the file as it is there. Rejects
   * with the server's words for a write refused.
   */
  async write(
    threadId: string,
    folder: { root: string },
    input: { path: FolderPath; text: string; expected: FileExpectation },
  ): Promise<Exclude<FileWriteResult, { kind: "conflict" }> | { kind: "conflict" }> {
    const threads = this.deps.hosted()?.threads;
    if (!threads?.writeFile) throw new Error(HOSTED_REASONS.fileWrite);
    const outcome = await threads.writeFile(threadId, { id: randomUUID(), ...input });
    if (outcome.kind === "refused") throw new Error(outcome.message);
    if (outcome.kind === "conflict") {
      if (!outcome.current) await this.copies.applyWrite(threadId, input.path, null);
      else if (outcome.current.text !== null) await this.copies.applyWrite(threadId, input.path, Buffer.from(outcome.current.text, "utf8"));
      return { kind: "conflict" };
    }
    await this.copies.applyWrite(threadId, input.path, Buffer.from(input.text, "utf8"));
    const version = FileVersion.parse(outcome.version);
    return { kind: "saved", root: folder.root, path: input.path, absolutePath: path.join(folder.root, input.path), version, text: null, formatError: null };
  }

  /** Whether the reader may write the thread's files from here: its server writes them and they may write the thread. */
  private async writes(threadId: string): Promise<boolean> {
    const known = this.writable.get(threadId);
    if (known && this.now() - known.at < CHECK_MS) return known.writes;
    const threads = this.deps.hosted()?.threads;
    const capabilities = await threads?.call("hosted.capabilities", { threadId }).catch(() => null);
    const collaboration = threads?.summary?.(threadId).owner?.collaboration;
    const writes = capabilities?.features.fileWrite?.available === true && collaboration?.canWrite !== false;
    // A read that failed says nothing of the server: the next read asks again.
    if (capabilities) this.writable.set(threadId, { at: this.now(), writes });
    return writes;
  }

  /** The file browser's Refresh: the copy brought up to its machine, or what that would end, named unless `endsOk`. */
  async refresh(threadId: string, endsOk: boolean): Promise<{ copy: CloudCopy } | { confirm: string[] }> {
    const work = await this.work(threadId);
    if (!work.current && work.ends.length && !endsOk) return { confirm: work.ends };
    return { copy: await this.bringUp(threadId, work, !work.current) };
  }

  /** A read's copy: the last save, made again only when a newer one is there. */
  private async read(threadId: string): Promise<CloudCopy> {
    const copy = await this.copies.ensure(threadId);
    this.checked.set(threadId, this.now());
    return copy;
  }

  private async work(threadId: string) {
    const hosted = this.deps.hosted();
    if (!hosted?.threads.holds({ thread: threadId })) throw new Error("That conversation isn't on OpenOrc Cloud.");
    const space = hosted.threads.row!(threadId).space;
    return { hosted, space, ...(await hosted.macProjects.workSave(space, threadId)) };
  }

  /** The copy, after the machine was asked to leave with its newer work when `leave`. A turn running there refuses. */
  private async bringUp(threadId: string, work: Awaited<ReturnType<CloudFolders["work"]>>, leave: boolean): Promise<CloudCopy> {
    const asked = leave ? await work.hosted.macProjects.ask(work.space, threadId).catch(() => null) : null;
    const copy = await this.copies.ensure(threadId, asked?.asked ? { after: work.save?.savedAt ?? NONE } : {});
    this.checked.set(threadId, this.now());
    return copy;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}
