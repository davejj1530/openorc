/**
 * A cloud thread's files as this Mac's file browser reads them: the reading copy of the thread's newest work save
 * (CloudCopies), read-only here. A copy not looked at for a while is first brought up to its machine: one that rests
 * with newer work is asked to leave with a save, which the copy waits for, but only when leaving ends nothing running
 * there (a terminal, a background command, delegated work). Otherwise, and while a turn runs, the copy stays the last
 * save; how old it is is the copy's own `asOf`, never passed off as live. Refresh asks the person before it ends anything.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";
import { projects } from "@openorc/db";
import { HOSTED_REASONS, type CloudCopy, type FileScope } from "@openorc/protocol";
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
    return { root: await realpath(folder), kind: "cloud", project, readOnly: HOSTED_REASONS.fileWrite, name: path.basename(project.rootPath) };
  }

  /** The file browser's Refresh: the copy brought up to its machine, or what that would end, named unless `endsOk`. */
  async refresh(threadId: string, endsOk: boolean): Promise<{ copy: CloudCopy } | { confirm: string[] }> {
    const work = await this.work(threadId);
    if (!work.current && work.ends.length && !endsOk) return { confirm: work.ends };
    return { copy: await this.bringUp(threadId, work, !work.current) };
  }

  /** A read's copy: leaving would end what runs there, so then the last save stands, and only Refresh asks. */
  private async read(threadId: string): Promise<CloudCopy> {
    const work = await this.work(threadId);
    return this.bringUp(threadId, work, !work.current && !work.ends.length);
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
