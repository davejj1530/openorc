import { constants } from "node:fs";
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { claudeAccounts, runs, threads, type Db } from "@openorc/db";
import { DEFAULT_CLAUDE_ACCOUNT, type AgentKind, type Run, type Thread } from "@openorc/protocol";
import type { Logger } from "../transport.js";
import type { RunService, StartRunInput } from "./runs.js";
import type { WorkspaceService } from "./workspace.js";

/** The folder where an account's Claude keeps its login, settings and sessions on this Mac. */
export type ClaudeFolder = (accountId: string) => string;

/** The other Claude account a turn names for its conversation; null when it stays. An Orcling's speaks with its own. */
export function switchedClaudeAccount(db: Db, thread: Thread, agent: AgentKind, requested: string | undefined): string | null {
  if (agent !== "claude" || !requested || requested === (thread.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT)) return null;
  if (thread.orclingId) throw new Error("An Orcling's conversation runs on the Orcling's Claude account.");
  if (!claudeAccounts.get(db, requested).enabled) throw new Error("This Claude account is disabled. Enable it in Settings → Connections.");
  return requested;
}

interface ThreadSessionDependencies {
  db: Db;
  runs: Pick<RunService, "liveRunForThread" | "threadActivity" | "closeAndWait">;
  workspaces: Pick<WorkspaceService, "cloudState">;
  handoffFor(thread: Thread, own: Run[], agent: AgentKind, fresh: boolean | undefined): string | undefined;
  log: Pick<Logger, "warn">;
  claudeFolder?: ClaudeFolder | undefined;
}

/** How a conversation's next run picks up its provider session. */
export class ThreadSessions {
  constructor(private readonly deps: ThreadSessionDependencies) {}

  /**
   * Closes the conversation's idle process, then says how the next run picks up its session. A conversation going on
   * with another Claude account moves there now: Claude resumes the session it carried along, or starts over with a
   * handoff when there is none to carry, as in a cloud conversation, whose session lives in its sandbox.
   */
  async next(thread: Thread, own: Run[], agent: AgentKind, fresh: boolean | undefined, account: string | null): Promise<Pick<StartRunInput, "resume" | "resumeFrom" | "handoff">> {
    const { db, runs: service } = this.deps;
    const previous = service.liveRunForThread(thread.id);
    if (previous) {
      if (service.threadActivity(thread.id) !== "idle") throw new Error("Wait for the current turn to finish before changing its session settings.");
      await service.closeAndWait(previous.id);
    }
    const carried = account && !fresh && !this.deps.workspaces.cloudState(thread.id) ? await this.carry(thread, account) : null;
    if (account) thread = threads.update(db, thread.id, { claudeAccountId: account });
    if (carried) return { resume: false, resumeFrom: carried };
    const restart = Boolean(fresh || account);
    const handoff = this.deps.handoffFor(thread, own, agent, restart);
    return { resume: !restart, ...(restart ? {} : (this.forkSource(thread, agent) ?? {})), ...(handoff ? { handoff } : {}) };
  }

  /** A fork's first run continues its parent's session as a new one; the parent keeps its own history. */
  private forkSource(thread: Thread, agent: AgentKind): { resumeFrom: { sessionId: string; fork: boolean } } | null {
    const { db } = this.deps;
    if (!thread.forkedFromId || runs.lastSession(db, { threadId: thread.id }, agent, null, thread.claudeAccountId ?? undefined)) return null;
    const parentSession = runs.lastSession(db, { threadId: thread.forkedFromId }, agent, null, thread.claudeAccountId ?? undefined);
    return parentSession ? { resumeFrom: { sessionId: parentSession, fork: true } } : null;
  }

  /** The conversation's last Claude session, copied into another account's folder to resume there as a fork. */
  private async carry(thread: Thread, to: string): Promise<{ sessionId: string; fork: true } | null> {
    const { db, claudeFolder } = this.deps;
    const from = thread.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT;
    const sessionId = runs.lastSession(db, { threadId: thread.id }, "claude", null, from);
    if (!claudeFolder || !sessionId) return null;
    try {
      return (await copySession(claudeFolder(from), claudeFolder(to), sessionId)) ? { sessionId, fork: true } : null;
    } catch (e) {
      this.deps.log.warn(`thread ${thread.id}: its Claude session stayed with the previous account: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }
}

/** Claude Code keeps a session at `<folder>/projects/<the folder it ran in>/<id>.jsonl`; the copy goes to the same place. */
async function copySession(from: string, to: string, sessionId: string): Promise<boolean> {
  const projects = path.join(from, "projects");
  for (const folder of await readdir(projects).catch(() => [] as string[])) {
    const file = path.join(projects, folder, `${sessionId}.jsonl`);
    if (!(await isFile(file))) continue;
    const target = path.join(to, "projects", folder, `${sessionId}.jsonl`);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    // A clone where the disk can make one: a long session runs to tens of megabytes.
    await copyFile(file, target, constants.COPYFILE_FICLONE);
    return true;
  }
  return false;
}

function isFile(file: string): Promise<boolean> {
  return stat(file).then(
    (entry) => entry.isFile(),
    () => false,
  );
}
