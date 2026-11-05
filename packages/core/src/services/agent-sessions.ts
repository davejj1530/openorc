import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionRefused, sessionId, slotFor, type AgentHome, type HostHome, type PackedSession, type SavedSession, type SessionId, type SessionSlot } from "@openorc/agents";
import type { WorkspaceLocation } from "@openorc/cloud";
import { claudeAccounts, runs, subagents, type CloudProviderId, type Db, type SessionBase } from "@openorc/db";
import { harnessCatalog, type Brain, type HarnessId, type Thread } from "@openorc/protocol";
import type { Logger } from "../transport.js";
import { RelocationRefused } from "./relocation-package.js";

export type { SessionBase };

/** A thread as a package names it, before its rows are written: whose session it is, and its subagents' native ids. */
export type TakenThread = Pick<Thread, "id" | "agent"> & { claudeAccountId: string | null | undefined; children: readonly string[] };

/** Whose agent folders: the thread's agent, and its Claude account. */
export type HomeOwner = Pick<Thread, "claudeAccountId"> & { agent: HarnessId };

/** Where each agent keeps its conversations: on this host, and in a thread's sandbox. */
export interface AgentHomes {
  /** The thread's agent folders on this host; Claude's are its account's. RelocationRefused for an account not here. */
  here(thread: HomeOwner): HostHome;
  /** Null when the sandbox's agent uses this host's own folders, as a sandbox simulated here without a cloud sign-in does. */
  sandbox(thread: HomeOwner, location: WorkspaceLocation, provider: CloudProviderId): Promise<AgentHome | null>;
}

/** Copies of a thread's sessions that another copy replaced, so none is ever lost. */
export const keptSessionsFolder = (dataDir: string, threadId: string) => path.join(dataDir, "kept-sessions", threadId);

const words = (error: unknown) => (error instanceof Error ? error.message : String(error));
const STAYS = "This agent's conversations stay where they started.";

/**
 * The one caller of the agents' session slots. It decides which session a thread has and keeps every copy another one
 * replaces; the slots only read and write each agent's own files. Every source copy stays where it was.
 */
export class AgentSessions {
  constructor(private readonly deps: { db: Db; dataDir: string; homes: AgentHomes; log: Logger }) {}

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
    if (!slot || !id || !thread.worktreePath) return null;
    const home = this.deps.homes.here(owner(thread, slot));
    return refusing(async () => {
      const saved = await slot.export(home, { sessionId: id, cwd: await home.realpath(thread.worktreePath!), children: this.children(thread.id) });
      return saved && { ...saved, cliVersion: await slot.version(home) };
    });
  }

  /** Refuses, before anything is written, a thread whose agent's conversations stay, or whose folders are not here. */
  assertTakeable(thread: TakenThread): void {
    const slot = slotFor(thread.agent);
    const stays = slot ? slot.stays : STAYS;
    if (stays || !slot) throw new RelocationRefused(stays ?? STAYS);
    this.deps.homes.here(owner(thread, slot));
  }

  /**
   * From a package, before the transaction that takes the thread: what this host held of the session is recorded under
   * the relocation (its copy, or that there was none), then the session goes where the agent resumes it from `folder`,
   * and the CLI here proves it can. A take run again after a crash finds the record and never reads a half-written copy.
   */
  async take(thread: TakenThread, saved: PackedSession, folder: string, relocation: string, from: Brain): Promise<void> {
    if (saved.agent !== thread.agent) throw new RelocationRefused("The conversation's session belongs to another agent.");
    const slot = slotFor(thread.agent);
    if (!slot) throw new RelocationRefused(STAYS);
    const home = this.deps.homes.here(owner(thread, slot));
    await refusing(async () => {
      const here = await slot.version(home);
      if (!slot.readable(saved.cliVersion, here)) throw new RelocationRefused(olderHere(slot.agent, saved.cliVersion, here, from));
      const ref = { sessionId: saved.sessionId, cwd: await home.realpath(folder), children: thread.children };
      if (!(await this.keptUnder(thread.id, relocation))) await this.keepAside(thread.id, relocation, await slot.export(home, ref));
      await slot.import(home, saved, ref.cwd);
      const reason = await slot.check(home, ref);
      if (reason) throw new RelocationRefused(reason);
    });
  }

  /** Host to sandbox, as the sandbox gets the code and while a standby's turn works here. */
  async send(thread: Thread, location: WorkspaceLocation, provider: CloudProviderId): Promise<SessionBase | null> {
    const slot = slotFor(thread.agent);
    const id = this.sessionOf(thread);
    if (!slot || !id || !thread.worktreePath) return null;
    const sandbox = await this.deps.homes.sandbox(owner(thread, slot), location, provider);
    if (!sandbox) return null;
    const host = this.deps.homes.here(owner(thread, slot));
    const saved = await slot.export(host, { sessionId: id, cwd: await host.realpath(thread.worktreePath), children: this.children(thread.id) });
    if (!saved) return null;
    return { sessionId: id, host: slot.digest(saved), sandbox: await slot.import(sandbox, saved, location.repo) };
  }

  /**
   * Sandbox to host after a turn. An unchanged sandbox writes nothing; a host copy that changed since `base` is kept
   * aside before the sandbox's goes in, since the sandbox's holds the newest turn. `required` (the thread leaves its
   * sandbox) throws when the session did not come; otherwise the next turn's keep tries again.
   */
  async keep(thread: Thread, location: WorkspaceLocation, provider: CloudProviderId, base: SessionBase | null, options: { required: boolean }): Promise<SessionBase | null> {
    const slot = slotFor(thread.agent);
    const id = this.sessionOf(thread);
    if (!slot || !id || !thread.worktreePath) return base;
    try {
      const sandbox = await this.deps.homes.sandbox(owner(thread, slot), location, provider);
      if (!sandbox) return base;
      const children = this.children(thread.id);
      const saved = await slot.export(sandbox, { sessionId: id, cwd: location.repo, children });
      if (!saved) return base;
      const sandboxDigest = slot.digest(saved);
      if (base?.sessionId === id && base.sandbox === sandboxDigest) return base;
      const host = this.deps.homes.here(owner(thread, slot));
      const cwd = await host.realpath(thread.worktreePath);
      const held = await slot.export(host, { sessionId: id, cwd, children });
      if (held && !(base?.sessionId === id && base.host === slot.digest(held))) {
        const kept = await this.keepAside(thread.id, String(Date.now()), held);
        this.deps.log.info(`thread ${thread.id}: its session here changed while its sandbox worked; this host's copy was kept in ${kept}`);
      }
      return { sessionId: id, host: await slot.import(host, saved, cwd), sandbox: sandboxDigest };
    } catch (error) {
      if (options.required) throw error;
      this.deps.log.warn(`could not bring thread ${thread.id}'s session from its sandbox: ${words(error)}`);
      return base;
    }
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

/** A conversation written by a newer CLI than the one where it lands, in words that say which side to update. */
function olderHere(agent: HarnessId, written: string, here: string, from: Brain): string {
  const { name, shortName } = harnessCatalog[agent];
  if (from === "cloud") return `This conversation last ran on ${shortName} ${written} in the cloud; this Mac has ${here}. Update ${name}, then try again.`;
  return `This conversation last ran on ${shortName} ${written} on your Mac; the cloud brain has ${here}. Try again once the cloud brain has updated it.`;
}

const owner = (thread: { claudeAccountId?: string | null | undefined }, slot: SessionSlot): HomeOwner => ({ agent: slot.agent, claudeAccountId: thread.claudeAccountId ?? null });

/** A slot's refusal is a move's refusal, in its words. */
async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SessionRefused) throw new RelocationRefused(error.message);
    throw error;
  }
}
