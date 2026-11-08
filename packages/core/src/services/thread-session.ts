import { constants } from "node:fs";
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { claudeAccounts, runs, threads, type Db } from "@openorc/db";
import { DEFAULT_CLAUDE_ACCOUNT, type AgentKind, type Run, type Thread } from "@openorc/protocol";
import type { Logger } from "../transport.js";
import { allowsAccount, NOT_A_PROJECT_ACCOUNT, projectAccountPolicy } from "./project-claude-accounts.js";
import type { RunService, StartRunInput } from "./runs.js";
import type { WorkspaceService } from "./workspace.js";

/** The folder where an account's Claude keeps its login, settings and sessions on this Mac. */
export type ClaudeFolder = (accountId: string) => string;

/**
 * The other Claude account a turn names for its conversation; null when it stays. An Orcling's speaks with its own, and
 * a project that uses only some accounts moves to no other.
 */
export function switchedClaudeAccount(db: Db, thread: Thread, agent: AgentKind, requested: string | undefined): string | null {
  if (agent !== "claude" || !requested || requested === (thread.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT)) return null;
  if (thread.orclingId) throw new Error("An Orcling's conversation runs on the Orcling's Claude account.");
  if (!claudeAccounts.get(db, requested).enabled) throw new Error("This Claude account is disabled. Enable it in Settings → Connections.");
  if (!allowsAccount(projectAccountPolicy(db, thread.projectId, { claudeAccountAutoSwitch: false }), requested)) throw new Error(NOT_A_PROJECT_ACCOUNT);
  return requested;
}

interface ThreadSessionDependencies {
  db: Db;
  runs: Pick<RunService, "liveRunForThread" | "threadActivity" | "closeAndWait" | "validateFastMode">;
  workspaces: Pick<WorkspaceService, "cloudState">;
  handoffFor(thread: Thread, own: Run[], agent: AgentKind, fresh: boolean | undefined): string | undefined;
  log: Pick<Logger, "warn">;
  claudeFolder?: ClaudeFolder | undefined;
}

/** How a conversation's next run picks up its provider session. */
export class ThreadSessions {
  constructor(private readonly deps: ThreadSessionDependencies) {}

  /** The conversation goes on with another Claude account from its next message. Its idle process, on the old one, closes now. */
  async switchAccount(thread: Thread, requested: string): Promise<Thread> {
    const account = switchedClaudeAccount(this.deps.db, thread, thread.agent, requested);
    if (!account) return thread;
    await this.deps.runs.validateFastMode(thread.agent, thread.model ?? undefined, thread.fastMode, undefined, undefined, account);
    await this.closeIdle(thread);
    return threads.update(this.deps.db, thread.id, { claudeAccountId: account });
  }

  /**
   * Closes the conversation's idle process, then says how the next run picks up its session. A conversation that went
   * on with another Claude account takes its newest session along: Claude resumes the copy, or starts over with a
   * handoff when there is none to carry, as in a cloud conversation, whose session lives in its sandbox.
   */
  async next(thread: Thread, own: Run[], agent: AgentKind, fresh: boolean | undefined, account: string | null): Promise<Pick<StartRunInput, "resume" | "resumeFrom" | "handoff">> {
    await this.closeIdle(thread);
    if (account) thread = threads.update(this.deps.db, thread.id, { claudeAccountId: account });
    const moved = agent === "claude" && !thread.orclingId ? movedSession(thread, own) : null;
    const carried = moved && !fresh && !this.deps.workspaces.cloudState(thread.id) ? await this.carry(thread, moved) : null;
    if (carried) return { resume: false, resumeFrom: carried };
    const restart = Boolean(fresh || moved);
    const handoff = this.deps.handoffFor(thread, own, agent, restart);
    return { resume: !restart, ...(restart ? {} : ((await this.forkSource(thread, agent)) ?? {})), ...(handoff ? { handoff } : {}) };
  }

  private async closeIdle(thread: Thread): Promise<void> {
    const service = this.deps.runs;
    const previous = service.liveRunForThread(thread.id);
    if (!previous) return;
    if (service.threadActivity(thread.id) !== "idle") throw new Error("Wait for the current turn to finish before changing its session settings.");
    await service.closeAndWait(previous.id);
  }

  /**
   * A fork's first run continues its parent's session as a new one; the parent keeps its own history. A fork on another
   * Claude account than its parent's, as its project's default once the project stopped using the parent's, takes a
   * copy of the parent's newest session along.
   */
  private async forkSource(thread: Thread, agent: AgentKind): Promise<{ resumeFrom: { sessionId: string; fork: boolean } } | null> {
    const { db } = this.deps;
    if (!thread.forkedFromId || runs.lastSession(db, { threadId: thread.id }, agent, null, thread.claudeAccountId ?? undefined)) return null;
    const parentSession = runs.lastSession(db, { threadId: thread.forkedFromId }, agent, null, thread.claudeAccountId ?? undefined);
    if (parentSession) return { resumeFrom: { sessionId: parentSession, fork: true } };
    if (agent !== "claude" || this.deps.workspaces.cloudState(thread.id)) return null;
    const moved = movedSession(
      thread,
      runs.listForThread(db, thread.forkedFromId).filter((run) => !run.orclingId),
    );
    const carried = moved ? await this.carry(thread, moved) : null;
    return carried ? { resumeFrom: carried } : null;
  }

  /** The conversation's newest Claude session, copied into its account's folder to resume there as a fork. */
  private async carry(thread: Thread, moved: MovedSession): Promise<{ sessionId: string; fork: true } | null> {
    const { claudeFolder } = this.deps;
    if (!claudeFolder) return null;
    try {
      return (await copySession(claudeFolder(moved.from), claudeFolder(thread.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT), moved.sessionId)) ? { sessionId: moved.sessionId, fork: true } : null;
    } catch (e) {
      this.deps.log.warn(`thread ${thread.id}: its Claude session stayed with the previous account: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }
}

type MovedSession = { sessionId: string; from: string };

/** The conversation's newest Claude session when it ran on another account than the conversation's now. */
function movedSession(thread: Thread, own: Run[]): MovedSession | null {
  const newest = own.findLast((run) => run.agent === "claude" && run.externalSessionId);
  const from = newest?.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT;
  if (!newest?.externalSessionId || from === (thread.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT)) return null;
  return { sessionId: newest.externalSessionId, from };
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
