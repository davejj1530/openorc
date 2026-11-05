import { randomUUID } from "node:crypto";
import { sessionId, slotFor, type HeadlessRun } from "@openorc/agents";
import { pushWorkspace, SANDBOX_PREFIX, seedWorkspace, type MirrorState, type RemoteProcess, type RunnerClient, type TakeoverStarted, type WorkspaceLocation } from "@openorc/cloud";
import { realpath } from "node:fs/promises";
import { checkpoints, cloudWorkspaces, retiredTeams, runs, threads, type Db, type LedgerWriter } from "@openorc/db";
import { diffStat, originUrl, pinObject, treeHash } from "@openorc/git";
import { harnessShortName, WORKSPACE_ID, type AgentEvent, type HarnessId, type Project, type Thread, type ThreadMessage } from "@openorc/protocol";
import type { Logger } from "../transport.js";
import { checkpointRefs } from "./checkpoint-refs.js";
import type { AgentSessions, SessionBase } from "./agent-sessions.js";
import type { CloudWorkspaceService, SandboxRef } from "./cloud-workspaces.js";

/** What the agent is told when its sandbox takes over the turn. */
const TAKEOVER_PROMPT =
  "This Mac went to sleep while you were working, so you are continuing in a cloud sandbox with the worktree's latest files. Your last steps may not all be in this session: check where the work stands, carry on with the task, and end with a short summary of what you did here.";
/** If this Mac disappears mid-turn without saying so, its sandbox takes over after this. */
const TAKEOVER_AFTER_MS = 2 * 60_000;
/** How long a sandbox that took over keeps going on its own while this Mac is away. */
const AWAY_MS = 2 * 60 * 60_000;
/** How long going to sleep waits for the last changes to reach a sandbox. */
const LAST_PUSH_MS = 2000;
/** How long waking up waits for a sandbox to answer before leaving its conversation as it is. */
const RECONNECT_MS = 20_000;
/** A session file can be large; while the turn works it goes up at most this often. */
const SESSION_EVERY_MS = 30_000;

interface Standby {
  thread: Thread;
  ref: SandboxRef;
  location: WorkspaceLocation;
  /** What the worktree and the sandbox both have. */
  mirror: MirrorState;
  /** What the sandbox got of the session at the last send, and what this Mac held then. */
  base: SessionBase | null;
  /** How the armed command's output reads, once armed. */
  parser: HeadlessRun["parser"] | null;
  /** For the turn in progress; null between turns. */
  turn: { client: RunnerClient; release: () => void; sessionId: string | null; sessionSentAt: number } | null;
  /** The sandbox carries the turn on: its runner connection is kept, whatever happens to the turn here, until the Mac takes it in. */
  carried: { client: RunnerClient; release: () => void } | null;
  /** One refresh at a time. */
  busy: Promise<void> | null;
}

export interface CloudStandbyDeps {
  db: Db;
  ledger: LedgerWriter;
  cloud: CloudWorkspaceService;
  sessions: AgentSessions;
  enabled(): Promise<boolean>;
  defaultAccountId(): string;
  project(thread: Thread): Project;
  runs: { liveRunForThread(threadId: string): { id: string } | null; interrupt(runId: string): Promise<void>; closeAndWait(runId: string): Promise<void> };
  recordMessage(threadId: string, message: ThreadMessage): void;
  invalidate(keys: string[]): void;
  log: Logger;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const within = <T>(ms: number, work: Promise<T>) => Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("took too long")), ms))]);

/**
 * Lets a conversation working on this Mac carry on in the cloud when the Mac goes to sleep. While a turn works, a
 * sandbox of its own keeps the worktree's files and the agent's session, with its command armed in the runner.
 * Going to sleep tells the runner to start it and stops the turn here; waking up takes the conversation to the cloud and
 * writes what the sandbox did into it as a turn of its own.
 */
export class CloudStandby {
  private readonly standbys = new Map<string, Standby>();
  private readonly starting = new Map<string, Promise<Standby | null>>();

  constructor(private readonly deps: CloudStandbyDeps) {}

  /** An agent whose conversations travel, in a worktree of a project, on this Mac, and visible: what a sandbox can carry on with. */
  private eligible(thread: Thread): boolean {
    if (slotFor(thread.agent)?.stays !== null || thread.workspaceMode !== "worktree" || !thread.worktreePath || !thread.branch) return false;
    if (thread.projectId === WORKSPACE_ID || cloudWorkspaces.get(this.deps.db, thread.id)) return false;
    return !retiredTeams.isHidden(this.deps.db, thread.id);
  }

  /** A sync hook call from a turn: its start, its working tick, or its end. Never rejects. */
  observe(thread: Thread, sync: { push?: boolean; turnEnded?: boolean } = {}): void {
    let work: Promise<void>;
    if (sync.turnEnded) work = this.turnEnded(thread.id);
    else if (sync.push) work = this.turnStarted(thread);
    else work = this.tick(thread);
    void work.catch((error: unknown) => this.deps.log.warn(`thread ${thread.id}'s standby sandbox: ${message(error)}`));
  }

  private async turnStarted(thread: Thread): Promise<void> {
    if (!this.eligible(thread) || !(await this.deps.enabled())) return;
    const standby = await this.standby(thread);
    if (!standby) return;
    standby.thread = thread;
    if (!standby.turn) {
      const release = this.deps.cloud.holdAwake(thread.id, standby.location.install.sandbox);
      const { client } = await this.deps.cloud.connect(standby.ref, thread.worktreePath!);
      standby.turn = { client, release, sessionId: null, sessionSentAt: 0 };
    }
    await this.refresh(standby, true);
  }

  private async tick(thread: Thread): Promise<void> {
    const standby = this.standbys.get(thread.id);
    if (!standby?.turn) return;
    // The Mac lost the sandbox for long enough mid-turn without going to sleep, and the sandbox carried on.
    const started = standby.turn.client.takeover;
    if (started) await this.takenOver(standby, standby.turn.client, started);
    else await this.refresh(standby, false);
  }

  /** Between turns there is nothing to take over; the sandbox may stop and keeps its files for the next turn. */
  private async turnEnded(threadId: string): Promise<void> {
    const standby = this.standbys.get(threadId);
    if (!standby?.turn) return;
    const { client, release } = standby.turn;
    standby.turn = null;
    client.standbyOff();
    release();
  }

  /** The conversation's standby, seeded from its worktree the first time. Null when its account cannot run there. */
  private standby(thread: Thread): Promise<Standby | null> {
    const existing = this.standbys.get(thread.id);
    if (existing) return Promise.resolve(existing);
    const pending = this.starting.get(thread.id) ?? this.seed(thread).finally(() => this.starting.delete(thread.id));
    this.starting.set(thread.id, pending);
    return pending;
  }

  private async seed(thread: Thread): Promise<Standby | null> {
    const project = this.deps.project(thread);
    const provider = await this.deps.cloud.place({ agent: thread.agent, claudeAccountId: thread.claudeAccountId ?? undefined, model: thread.model }, project).catch((error: unknown) => {
      this.deps.log.info(`thread ${thread.id} has no standby sandbox: ${message(error)}`);
      return null;
    });
    if (!provider) return null;
    const ref = { threadId: thread.id, provider, sandbox: `${SANDBOX_PREFIX}${thread.id}` };
    const location = await this.deps.cloud.location(ref, thread.worktreePath!);
    const release = this.deps.cloud.holdAwake(thread.id, location.install.sandbox);
    try {
      const mirror = await seedWorkspace(location, thread.branch!, (await originUrl(project.rootPath)) ?? undefined);
      const standby: Standby = { thread, ref, location, mirror, base: null, parser: null, turn: null, carried: null, busy: null };
      this.standbys.set(thread.id, standby);
      return standby;
    } finally {
      release();
    }
  }

  /** Sends the worktree's changes and, now and then, the session; arms the takeover once the session is known. */
  private refresh(standby: Standby, now: boolean): Promise<void> {
    if (standby.busy) return now ? standby.busy.then(() => this.refresh(standby, now)) : standby.busy;
    standby.busy = this.refreshOnce(standby, now).finally(() => (standby.busy = null));
    return standby.busy;
  }

  private async refreshOnce(standby: Standby, now: boolean): Promise<void> {
    const turn = standby.turn;
    if (!turn) return;
    standby.mirror = (await pushWorkspace(standby.location, standby.mirror)).state;
    if (now || Date.now() - turn.sessionSentAt >= SESSION_EVERY_MS) {
      await this.deps.cloud.installAgent(standby.thread.agent as HarnessId, standby.location, standby.ref.provider);
      standby.base = await this.deps.sessions.send(standby.thread, standby.location, standby.ref.provider);
      turn.sessionSentAt = Date.now();
    }
    const { thread } = standby;
    const accountId = thread.claudeAccountId ?? this.deps.defaultAccountId();
    const session = sessionId(runs.lastSession(this.deps.db, { threadId: thread.id }, thread.agent, null, accountId));
    // A first turn's session is known once the agent starts it; a later tick arms it then.
    if (!session || session === turn.sessionId) return;
    const env = await this.deps.cloud.turnEnv(thread, standby.location, standby.ref.provider);
    const run = slotFor(thread.agent)!.continueOnce({ sessionId: session }, TAKEOVER_PROMPT, thread);
    const { cmd, args, parser } = run;
    turn.client.standby({ id: `takeover-${randomUUID()}`, cmd, args, cwd: standby.location.repo, env: run.env ? run.env(env) : env, afterMs: TAKEOVER_AFTER_MS });
    standby.parser = parser;
    turn.sessionId = session;
  }

  /**
   * This Mac is going to sleep. Each working conversation's last changes go up if they can in time, its sandbox takes
   * over, and its turn here stops. A sandbox that misses this takes over on its own once it misses the Mac.
   */
  async away(): Promise<void> {
    await Promise.all(
      [...this.standbys.values()].map(async (standby) => {
        const turn = standby.turn;
        if (!turn?.sessionId) return;
        await within(LAST_PUSH_MS, this.refresh(standby, false)).catch(() => undefined);
        if (!(await turn.client.away())) return;
        standby.carried = { client: turn.client, release: turn.release };
        standby.turn = null;
        const live = this.deps.runs.liveRunForThread(standby.ref.threadId);
        if (live) await this.deps.runs.interrupt(live.id).catch(() => undefined);
      }),
    );
    await this.deps.cloud.away(AWAY_MS);
  }

  /** OpenOrc is quitting: its turns end with it, so no sandbox takes one over. */
  close(): void {
    for (const standby of this.standbys.values()) {
      standby.turn?.client.standbyOff();
      standby.turn?.release();
      standby.turn = null;
    }
  }

  /** This Mac is back: each conversation whose sandbox took over moves to the cloud, with what it did there. */
  async back(): Promise<void> {
    await Promise.all(
      [...this.standbys.values()].map(async (standby) => {
        const client = standby.carried?.client ?? standby.turn?.client;
        if (!client) return;
        await waitFor(() => client.connected, RECONNECT_MS);
        if (client.takeover) await this.takenOver(standby, client, client.takeover);
      }),
    );
  }

  private async takenOver(standby: Standby, client: RunnerClient, started: TakeoverStarted): Promise<void> {
    const { threadId } = standby.ref;
    this.standbys.delete(threadId);
    const release = standby.carried?.release ?? standby.turn?.release ?? (() => undefined);
    standby.turn = null;
    standby.carried = null;
    const live = this.deps.runs.liveRunForThread(threadId);
    if (live) await this.deps.runs.closeAndWait(live.id).catch(() => undefined);
    this.deps.cloud.adopt(standby.ref, standby.mirror, standby.base);
    this.deps.cloud.takingOver(threadId, true);
    this.deps.recordMessage(threadId, { id: randomUUID(), role: "system", text: "This Mac went to sleep, so the turn carried on in the cloud.", createdAt: started.at });
    try {
      const runId = await this.record(standby, client.adopt(started.id));
      client.takeoverSeen();
      const thread = threads.get(this.deps.db, threadId);
      if (thread) {
        await this.deps.cloud.sync(thread, { turnEnded: true });
        await this.checkpoint(thread, runId);
      }
    } finally {
      this.deps.cloud.takingOver(threadId, false);
      release();
      this.deps.invalidate(["threads", `thread:${threadId}`, `runs:thread:${threadId}`]);
    }
  }

  /** The turn's files as it ended, as a turn on this Mac saves them, so the next turn sees them as its own work. */
  private async checkpoint(thread: Thread, runId: string): Promise<void> {
    const cwd = thread.worktreePath;
    if (!cwd) return;
    const tree = await treeHash(cwd);
    await pinObject(cwd, `${checkpointRefs(thread.id)}${tree}`, tree);
    checkpoints.insert(this.deps.db, { threadId: thread.id, runId, turn: 1, treeSha: tree, diffStat: await diffStat(cwd, thread.baseSha), root: await realpath(cwd) });
  }

  /** Writes what the agent did in the sandbox into the conversation as a turn, as its output arrives. Resolves with the run. */
  private async record(standby: Standby, proc: RemoteProcess): Promise<string> {
    const { thread } = standby;
    const runId = randomUUID();
    const started = Date.now();
    runs.insert(this.deps.db, {
      id: runId,
      taskId: null,
      threadId: thread.id,
      agent: thread.agent,
      model: thread.model,
      effort: thread.effort,
      mode: thread.mode,
      permissionMode: thread.permissionMode,
      claudeAccountId: thread.claudeAccountId ?? null,
    });
    // The runner starts only an armed command, and arming keeps its parser.
    if (!standby.parser) throw new Error(`thread ${thread.id}'s sandbox took over a turn it was never armed for`);
    const parser = standby.parser(runId);
    let pending = "";
    let sessionId: string | null = null;
    let resultText: string | null = null;
    const take = (ev: AgentEvent) => {
      if (ev.type === "session.started") sessionId = ev.externalSessionId;
      if (ev.type === "turn.completed") resultText = ev.resultText ?? resultText;
      this.deps.ledger.push(ev);
    };
    proc.stdout.on("data", (chunk: Buffer) => {
      const lines = (pending + chunk.toString("utf8")).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) parser.parseLine(line).forEach(take);
      this.deps.ledger.flush();
      this.deps.invalidate([`runs:thread:${thread.id}`]);
    });
    const code = await new Promise<number | null>((resolve) => proc.once("close", (exit: number | null) => resolve(exit)));
    if (pending.trim()) parser.parseLine(pending).forEach(take);
    parser.end?.(code).forEach(take);
    const status = code === 0 ? "success" : "error";
    take({ type: "session.completed", runId, ts: Date.now(), status, durationMs: Date.now() - started, turns: parser.turns });
    this.deps.ledger.flush();
    runs.update(this.deps.db, runId, {
      state: status,
      endedAt: Date.now(),
      externalSessionId: sessionId,
      resultText,
      ...(code === 0 ? {} : { error: `${harnessShortName(thread.agent)} stopped in the cloud before finishing the turn.` }),
    });
    return runId;
  }
}

async function waitFor(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
}
