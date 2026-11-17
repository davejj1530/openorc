import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionRefused, sessionId, slotFor, type HostHome, type PackedSession, type SavedSession, type SessionId, type SessionSlot } from "@openorc/agents";
import { claudeAccounts, projects, runs, subagents, type Db } from "@openorc/db";
import { harnessCatalog, type HarnessId, type Thread } from "@openorc/protocol";

/*
 * Kept from the person's own cloud, which is gone, for an OpenOrc Cloud thread's agent session to travel to and from
 * this Mac on (see .local-development/multiplayer/ui/cloud-parity/build/from-own-cloud.md). Nothing in the app calls it
 * today. A refusal is the slots' own `SessionRefused`, in words a person can read.
 */

/** A thread as a package names it, before its rows are written: whose session it is, and its subagents' native ids. */
export type TakenThread = Pick<Thread, "id" | "agent"> & { claudeAccountId: string | null | undefined; children: readonly string[] };

/** Whose agent folders: the thread's agent, and its Claude account. */
export type HomeOwner = Pick<Thread, "claudeAccountId"> & { agent: HarnessId };

/** Where each agent keeps its conversations on this host. */
export interface AgentHomes {
  /** The thread's agent folders on this host; Claude's are its account's. SessionRefused for an account not here. */
  here(thread: HomeOwner): HostHome;
}

/** Copies of a thread's sessions that another copy replaced, so none is ever lost. */
export const keptSessionsFolder = (dataDir: string, threadId: string) => path.join(dataDir, "kept-sessions", threadId);

const STAYS = "This agent's conversations stay where they started.";

/**
 * The one caller of the agents' session slots. It decides which session a thread has and keeps every copy another one
 * replaces; the slots only read and write each agent's own files. Every source copy stays where it was.
 */
export class AgentSessions {
  constructor(private readonly deps: { db: Db; dataDir: string; homes: AgentHomes }) {}

  /** The thread's newest session at this host; Claude's for the thread's account. */
  private sessionOf(thread: Pick<Thread, "id" | "agent" | "claudeAccountId">): SessionId | null {
    const account = thread.claudeAccountId ?? claudeAccounts.defaultId(this.deps.db);
    return sessionId(runs.lastSession(this.deps.db, { threadId: thread.id }, thread.agent, null, account));
  }

  private children(threadId: string): string[] {
    return subagents.forRoot(this.deps.db, threadId).map((row) => row.nativeId);
  }

  /** The thread's newest session at this host, for a package; null before its first turn. */
  async export(thread: Thread): Promise<PackedSession | null> {
    const slot = slotFor(thread.agent);
    const id = this.sessionOf(thread);
    // A thread in the project's checkout ran its agent there.
    const folder = thread.worktreePath ?? projects.get(this.deps.db, thread.projectId)?.rootPath;
    if (!slot || !id || !folder) return null;
    const home = this.deps.homes.here(owner(thread, slot));
    const saved = await slot.export(home, { sessionId: id, cwd: await home.realpath(folder), children: this.children(thread.id) });
    return saved && { ...saved, cliVersion: await slot.version(home) };
  }

  /** Refuses, before anything is written, a thread whose agent's conversations stay, or whose folders are not here. */
  assertTakeable(thread: TakenThread): void {
    const slot = slotFor(thread.agent);
    const stays = slot ? slot.stays : STAYS;
    if (stays || !slot) throw new SessionRefused(stays ?? STAYS);
    this.deps.homes.here(owner(thread, slot));
  }

  /**
   * From a package, before the thread's rows are written: what this host held of the session is recorded under `label`
   * (its copy, or that there was none), then the session goes where the agent resumes it from `folder`, and the CLI
   * here proves it can. A take run again after a crash finds the record and never reads a half-written copy.
   */
  async take(thread: TakenThread, saved: PackedSession, folder: string, label: string): Promise<void> {
    if (saved.agent !== thread.agent) throw new SessionRefused("The conversation's session belongs to another agent.");
    const slot = slotFor(thread.agent);
    if (!slot) throw new SessionRefused(STAYS);
    const home = this.deps.homes.here(owner(thread, slot));
    const here = await slot.version(home);
    if (!slot.readable(saved.cliVersion, here)) throw new SessionRefused(olderHere(slot.agent, saved.cliVersion, here));
    const ref = { sessionId: saved.sessionId, cwd: await home.realpath(folder), children: thread.children };
    if (!(await this.keptUnder(thread.id, label))) await this.keepAside(thread.id, label, await slot.export(home, ref));
    await slot.import(home, saved, ref.cwd);
    const reason = await slot.check(home, ref);
    if (reason) throw new SessionRefused(reason);
  }

  private async keptUnder(threadId: string, label: string): Promise<boolean> {
    return Boolean(await stat(path.join(keptSessionsFolder(this.deps.dataDir, threadId), label)).catch(() => null));
  }

  /** Records a displaced copy, or that there was none, under `label`. Written aside, then renamed, so a crash never leaves half a record. */
  private async keepAside(threadId: string, label: string, saved: SavedSession | null): Promise<string> {
    const folder = path.join(keptSessionsFolder(this.deps.dataDir, threadId), label);
    const partial = `${folder}.${randomUUID()}.partial`;
    await mkdir(partial, { recursive: true, mode: 0o700 });
    const parts = saved?.parts ?? [];
    for (const [index, part] of parts.entries()) await writeFile(path.join(partial, `part-${index}`), part.bytes, { mode: 0o600 });
    const held = saved && { agent: saved.agent, format: saved.format, cliVersion: saved.cliVersion, sessionId: saved.sessionId, meta: saved.meta, parts: parts.map((part) => part.name) };
    await writeFile(path.join(partial, "meta.json"), JSON.stringify({ held, keptAt: Date.now() }), { mode: 0o600 });
    await rename(partial, folder);
    return folder;
  }
}

/** A deleted thread's kept copies go with it. */
export function forgetKeptSessions(dataDir: string, threadId: string): Promise<void> {
  return rm(keptSessionsFolder(dataDir, threadId), { recursive: true, force: true });
}

/** A conversation written by a newer CLI than the one here, in words that say what to update. */
function olderHere(agent: HarnessId, written: string, here: string): string {
  const { name, shortName } = harnessCatalog[agent];
  return `This conversation last ran on ${shortName} ${written} in the cloud; this Mac has ${here}. Update ${name}, then try again.`;
}

const owner = (thread: { claudeAccountId?: string | null | undefined }, slot: SessionSlot): HomeOwner => ({ agent: slot.agent, claudeAccountId: thread.claudeAccountId ?? null });
