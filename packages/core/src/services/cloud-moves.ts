/**
 * A thread moving between this Mac and OpenOrc Cloud, keeping its id, so everything that names it (its tabs, pins,
 * unread mark, the phone's open screen) follows it to its new place. The move-thread design in
 * .local-development/multiplayer/run-nov14/move-thread/design.md; the server's half is its `hosted/arrivals.ts`.
 *
 *   to the cloud   the thread takes no turn (runs.ts). Its agent's conversation (the session slot), its folder's work
 *                  (a Mac start's pack) and its transcript are read here first; then the arrival is made on the server
 *                  under its id, hidden, and filled; once the server says done and this Mac hears the cloud thread,
 *                  the thread here is deleted as Delete does, its worktree's changes kept on its branch
 *   to this Mac    a thread of the person's own space only. It leaves its cloud machine with a save (asking first only
 *                  when something running would end, as Bring does); its save's commits come into the project's folder
 *                  as its branch, checked, and a worktree on it gets its uncommitted work back; its transcript becomes
 *                  a run here, its conversation is taken into the agent's folders with a resume check; all of it hidden
 *                  until whole, then shown while its reads still go to the cloud, until the server lets the cloud
 *                  thread go and this Mac's list of cloud threads drops it
 *
 * This Mac's journal (`cloudMoves`, thread_relocations) says where each move stands. A move that stops before its
 * commit point is undone, the thread stays where it was, and its place row says why ("Didn't move: …").
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { packSession, SessionRefused, unpackSession, type PackedSession } from "@openorc/agents";
import { cloudMoves, listEvents, orclings, projects, runs, subagents, threads, type CloudMove, type Db, type LedgerWriter, type SubagentRecord } from "@openorc/db";
import { bringIntoFolder, git } from "@openorc/git";
import type { ArrivalLine, ArrivalSettings, Hosted } from "@openorc/hosted";
import {
  harnessShortName,
  isHostedAgent,
  movingHold,
  WORKSPACE_ID,
  type AgentEvent,
  type CloudMoveCheck,
  type CloudMoveStart,
  type ComputerNames,
  type Project,
  type Thread,
  type ThreadMoving,
} from "@openorc/protocol";
import type { AgentSessions } from "./agent-sessions.js";
import { packProject, uploadOf } from "./mac-work.js";
import type { WorkspaceService } from "./workspace.js";

const WORKING = "The agent is still working. Move it once it stops.";
const NOT_IN_CLOUD = "Add this project to OpenOrc Cloud in Settings first.";
const SIGN_IN = "Sign in to OpenOrc to move this thread.";
const SUBTHREAD_ALONE = "A subthread moves with the thread it was started under.";
const OWN_FOLDER = "A subthread of this thread works in a folder of its own, so it can't move to OpenOrc Cloud.";
/** A thread started under a cloud thread, as this Mac last heard it. */
type FamilyRow = ReturnType<NonNullable<Hosted["threads"]["family"]>>[number];
/** The most threads started under a thread, at any depth, that move with it, as the server takes them. */
const MOST_SUBTHREADS = 20;
/** A folder here where the thread's worktree goes, holding work of its own: a move never overwrites it. */
class FolderInTheWay extends Error {
  constructor(readonly folder: string) {
    super("A folder for this thread is already where its worktree goes, with other work in it. Move that work aside, then try again.");
  }
}

/** How long a move to this Mac waits for the thread to leave its cloud machine with a save. */
const CURRENT_MS = 3 * 60_000;
/** How long a move to the cloud waits for this Mac's list of cloud threads to take the thread in. */
const HEARD_MS = 30_000;

const words = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** The words, and for the log what lies behind them (a CLI's path and what it said). */
const logged = (error: unknown) => (error instanceof Error && error.cause !== undefined ? `${words(error)} (${String(error.cause)})` : words(error));

/** A subagent's status as the cloud keeps a finished one: one still marked running here was stopped by the move's wait. */
const CHILD_STATUS: Record<SubagentRecord["status"], "completed" | "failed" | "stopped"> = {
  running: "stopped",
  completed: "completed",
  failed: "failed",
  stopped: "stopped",
  no_updates: "completed",
};
/** How a run here ended, as the cloud keeps a turn's outcome; a run still going reads as one that ended well. */
const OUTCOMES: Partial<Record<string, "error" | "cancelled">> = { error: "error", cancelled: "cancelled" };

export interface CloudMovesDeps {
  db: Db;
  hosted: () => Hosted | null;
  sessions: AgentSessions;
  ledger: LedgerWriter;
  workspaces: WorkspaceService;
  /** Deletes the thread here as Delete does, its worktree's changes kept on its branch. */
  deleteThread(threadId: string): Promise<void>;
  /** Where the thread's move stands changed: its lists and its own view read it again. */
  changed(threadId: string): void;
  /**
   * The thread is read at another place from now on: every window reads it again where it is, and lets go of what it
   * read where it was.
   */
  placed(threadId: string): void;
  /** What the app calls this computer, in the words a move says. */
  here: ComputerNames;
  now?: () => number;
  log: { info(message: string): void; warn(message: string): void };
}

export class CloudMoves {
  constructor(private readonly deps: CloudMovesDeps) {}

  /** Where the thread is moving, or why its last move stopped; null when neither. For its summary. */
  moving(threadId: string): ThreadMoving | null {
    return cloudMoves.moving(this.deps.db, threadId);
  }

  /** Puts away why the thread's last move stopped; a move under way goes on. */
  dismiss(threadId: string): void {
    if (cloudMoves.open(this.deps.db, threadId)) return;
    cloudMoves.forget(this.deps.db, threadId);
    this.deps.changed(threadId);
  }

  /** Whether the thread can move from where it is now, and where it would land, or why not. */
  async check(threadId: string): Promise<CloudMoveCheck> {
    const hosted = this.deps.hosted();
    if (hosted?.threads.holds({ thread: threadId })) return this.checkToMac(hosted, threadId);
    const thread = threads.get(this.deps.db, threadId);
    if (!thread || thread.projectId === WORKSPACE_ID || thread.parentRelation === "subagent" || this.ofTask(threadId) || orclings.forThread(this.deps.db, threadId)) return { to: "none" };
    const held = (reason: string): CloudMoveCheck => ({ to: "cloud", can: false, reason });
    if (thread.parentRelation === "started") return held(SUBTHREAD_ALONE);
    const moving = movingHold(this.moving(threadId), this.deps.here.machine);
    if (moving) return held(moving);
    if (!hosted || hosted.spaces.status().state !== "ready") return held(SIGN_IN);
    if (!isHostedAgent(thread.agent)) return held(`${harnessShortName(thread.agent)} doesn't run on OpenOrc Cloud.`);
    const family = this.familyHold(thread);
    if (family) return held(family);
    const cloud = hosted.threads.cloudProjectFor?.(thread.projectId);
    if (!cloud) return held(NOT_IN_CLOUD);
    const status = hosted.spaces.status();
    return { to: "cloud", can: true, space: { id: cloud.space, personal: status.state === "ready" && status.personalSpaceId === cloud.space } };
  }

  private async checkToMac(hosted: Hosted, threadId: string): Promise<CloudMoveCheck> {
    const held = (reason: string): CloudMoveCheck => ({ to: "mac", can: false, reason });
    const row = hosted.threads.row!(threadId);
    if (row.relation === "started") return held(SUBTHREAD_ALONE);
    const status = hosted.spaces.status();
    const moving = movingHold(this.moving(threadId), this.deps.here.machine);
    if (moving) return held(moving);
    if (status.state !== "ready" || row.space !== status.personalSpaceId) return held(`Only a thread in your own space can move to ${this.deps.here.thisComputer}.`);
    const local = this.localProjectOf(hosted, threadId);
    if (!local) return held(`This project isn't on ${this.deps.here.thisComputer}.`);
    try {
      for (const one of [row, ...(hosted.threads.family?.(threadId) ?? [])]) await this.deps.sessions.assertTakeable({ id: one.id, agent: one.settings.agent, claudeAccountId: null, children: [] });
    } catch (error) {
      if (error instanceof SessionRefused) return held(error.message);
      throw error;
    }
    const work = await hosted.macProjects.workSave(row.space, threadId);
    if (work.working) return held(WORKING);
    return { to: "mac", can: true, ends: work.current ? [] : work.ends };
  }

  /**
   * Why the threads started under the thread can't go with it, or null. They go in its folder, as the cloud keeps one
   * folder for them all, and each runs there.
   */
  private familyHold(thread: Thread): string | null {
    const family = threads.startedUnder(this.deps.db, thread.id);
    if (family.length > MOST_SUBTHREADS) return `A thread with more than ${MOST_SUBTHREADS} subthreads can't move to OpenOrc Cloud.`;
    const elsewhere = family.find((member) => !isHostedAgent(member.agent));
    if (elsewhere) return `A subthread of this thread runs ${harnessShortName(elsewhere.agent)}, which doesn't run on OpenOrc Cloud.`;
    if ([thread, ...family].some((one) => this.working(one.id))) return WORKING;
    if (family.some((member) => member.projectId !== thread.projectId || member.worktreePath !== thread.worktreePath)) return OWN_FOLDER;
    return null;
  }

  /** Whether the thread here, or a helper of its agent, is working. */
  private working(threadId: string): boolean {
    return runs.listForThread(this.deps.db, threadId).some((run) => run.state === "starting" || run.state === "running") || subagents.hasWorkingDescendants(this.deps.db, threadId);
  }

  /** Whether a task opened the thread: its work is the task's, which stays with it. */
  private ofTask(threadId: string): boolean {
    return Boolean(this.deps.db.stmt("SELECT 1 FROM tasks WHERE thread_id = ? LIMIT 1").get(threadId));
  }

  /** The project here a cloud thread's project is, as its summary pairs them; null when none is here. */
  private localProjectOf(hosted: Hosted, threadId: string): Project | null {
    const summary = hosted.threads.summary?.(threadId);
    return summary ? projects.get(this.deps.db, summary.projectId) : null;
  }

  /** Starts the thread's move; a move to this Mac asks first when leaving its machine would end something. */
  async move(threadId: string, endsOk: boolean): Promise<CloudMoveStart> {
    const check = await this.check(threadId);
    if (check.to === "none") throw new Error("This thread stays where it is.");
    if (!check.can) throw new Error(check.reason);
    if (check.to === "mac" && check.ends.length && !endsOk) return { confirm: check.ends };
    const hosted = this.deps.hosted()!;
    if (check.to === "cloud") {
      const thread = threads.get(this.deps.db, threadId)!;
      const move = cloudMoves.begin(this.deps.db, { threadId, direction: "to-cloud", projectId: thread.projectId });
      this.deps.changed(threadId);
      void this.toCloud(hosted, move, thread, check.space.id);
    } else {
      const local = this.localProjectOf(hosted, threadId)!;
      const move = cloudMoves.begin(this.deps.db, { threadId, direction: "to-mac", projectId: local.id });
      this.deps.changed(threadId);
      void this.toMac(hosted, move, local);
    }
    return { started: true };
  }

  private step(move: CloudMove, patch: Parameters<typeof cloudMoves.set>[2]): void {
    cloudMoves.set(this.deps.db, move.id, patch);
    this.deps.changed(move.threadId);
  }

  /** The thread's agent, model, effort and modes, as a cloud thread is made with them. */
  private settingsOf(thread: Thread): ArrivalSettings {
    return { agent: thread.agent, model: thread.model, effort: thread.effort, mode: thread.mode, permissionMode: thread.permissionMode };
  }

  private async toCloud(hosted: Hosted, move: CloudMove, thread: Thread, space: string): Promise<void> {
    const cloud = hosted.threads.cloudProjectFor!(thread.projectId)!;
    let made = false;
    try {
      // Everything is read before anything leaves.
      this.step(move, { step: "packing" });
      const family = threads.startedUnder(this.deps.db, thread.id);
      const session = await this.deps.sessions.export(thread);
      const familySessions = [];
      for (const member of family) familySessions.push({ member, session: await this.deps.sessions.export(member) });
      const folder = thread.worktreePath ?? projects.get(this.deps.db, thread.projectId)?.rootPath;
      const pack = folder ? await packProject(this.deps.db, thread.projectId, [], folder) : null;
      const packed = pack && uploadOf(pack);
      if (packed?.refusal) {
        await packed.done();
        throw new Error(packed.refusal);
      }
      const upload = packed && packed.refusal === null ? packed : null;
      this.step(move, { phase: "sending", step: "history" });
      await hosted.moves.arrive(space, { id: thread.id, projectId: cloud.id, title: thread.title, settings: this.settingsOf(thread) });
      made = true;
      await hosted.moves.history(space, thread.id, () => this.historyOf(thread, family));
      this.step(move, { step: "conversation" });
      for (const { member, session: one } of [{ member: null, session }, ...familySessions]) {
        if (!one) continue;
        const query = { agent: one.agent, sessionId: one.sessionId, cliVersion: one.cliVersion, ...(member ? { thread: member.id } : {}) };
        await hosted.moves.session(space, thread.id, query, packSession(one));
      }
      if (upload) {
        this.step(move, { step: "work" });
        try {
          await hosted.moves.work(space, thread.id, upload);
        } finally {
          await upload.done();
        }
      }
      await hosted.moves.done(space, thread.id);
    } catch (error) {
      if (made) await hosted.moves.undo(space, thread.id).catch(() => undefined);
      this.step(move, { phase: "abandoned", step: null, error: words(error) });
      this.deps.log.warn(`thread ${thread.id} didn't move to OpenOrc Cloud: ${logged(error)}`);
      return;
    }
    // The commit point is passed: the cloud thread is whole. Let the Mac's go once the cloud's is heard, so the thread is
    // never in neither list.
    await this.heard(hosted, thread.id);
    for (const one of [thread, ...threads.startedUnder(this.deps.db, thread.id)]) this.deps.placed(one.id);
    this.step(move, { phase: "done", step: null });
    await this.deleteFamily(thread.id).catch((error: unknown) => this.deps.log.warn(`thread ${thread.id} moved to OpenOrc Cloud and its copy here couldn't be deleted: ${words(error)}`));
    this.deps.changed(thread.id);
  }

  /** Deletes a thread here and every thread started under it, each after those started under it. */
  private async deleteFamily(threadId: string): Promise<void> {
    for (const member of threads.startedUnder(this.deps.db, threadId).reverse()) await this.deps.deleteThread(member.id);
    await this.deps.deleteThread(threadId);
  }

  /** Waits a while for this Mac's list of cloud threads to hold the thread it just made, reading the server again meanwhile. */
  private async heard(hosted: Hosted, threadId: string): Promise<void> {
    const until = (this.deps.now ?? Date.now)() + HEARD_MS;
    const known = () => hosted.threads.holds({ thread: threadId });
    while (!known() && (this.deps.now ?? Date.now)() < until) {
      await hosted.threads.refresh?.().catch(() => undefined);
      if (!known()) await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  /**
   * The thread's transcript as the arrival takes it: its conversation, then each thread started under it, each after
   * the one it was started under, with its own conversation.
   */
  private async *historyOf(thread: Thread, family: Thread[]): AsyncGenerator<ArrivalLine> {
    yield* this.conversationOf(thread, null);
    for (const member of family) {
      yield {
        kind: "subthread",
        id: member.id,
        parentId: member.parentThreadId!,
        title: member.title,
        settings: this.settingsOf(member),
        createdAt: new Date(member.createdAt).toISOString(),
        startedByAgent: member.startedByAgent ?? false,
        archivedAt: member.archivedAt === null ? null : new Date(member.archivedAt).toISOString(),
      };
      yield* this.conversationOf(member, member.id);
    }
  }

  /**
   * One conversation: each person's message and what followed it, as one turn; then each of its agent's helpers as a
   * thread of its own, under its id here, with its native record and what it did, named to the conversation (`as`, or
   * none for the moving thread's).
   */
  private *conversationOf(thread: Thread, as: string | null): Generator<ArrivalLine> {
    // The turn each helper started in, by its card in the conversation's events.
    const startedIn = new Map<string, string>();
    for (const turn of this.turnsOf(thread)) {
      for (const event of turn.events) if (event["type"] === "subagent.started" && typeof event["threadId"] === "string") startedIn.set(event["threadId"], turn.id);
      yield turn;
    }
    for (const child of subagents.forRoot(this.deps.db, thread.id)) {
      const line = this.childOf(child, startedIn.get(child.threadId) ?? null);
      if (!line) continue;
      yield as ? { ...line, thread: as } : line;
      yield* this.turnsOf(threads.get(this.deps.db, child.threadId)!);
    }
  }

  /** A thread's runs as turns: each person's message and what followed it, as one turn. */
  private *turnsOf(thread: Thread): Generator<Extract<ArrivalLine, { kind: "turn" }>> {
    const settings = this.settingsOf(thread);
    for (const run of runs.listForThread(this.deps.db, thread.id)) {
      const outcome = OUTCOMES[run.state] ?? "success";
      let turn: Extract<ArrivalLine, { kind: "turn" }> | null = null;
      for (const event of listEvents(this.deps.db, run.id, { limit: Number.MAX_SAFE_INTEGER })) {
        const at = new Date(event.ts).toISOString();
        if (event.type === "message.completed" && event.role === "user") {
          if (turn) yield turn;
          turn = { kind: "turn", thread: thread.id, id: randomUUID(), settings, startedAt: at, endedAt: at, outcome, message: { id: randomUUID(), text: event.text }, events: [] };
          continue;
        }
        turn ??= { kind: "turn", thread: thread.id, id: randomUUID(), settings, startedAt: at, endedAt: at, outcome, message: null, events: [] };
        const { runId: _runId, eventId: _eventId, ...rest } = event as AgentEvent & { eventId?: string };
        turn.events.push(rest);
        turn.endedAt = at;
      }
      if (turn) yield turn;
    }
  }

  /**
   * A subagent as the arrival takes it: its thread here, the agent's own name for it and the conversation it ran in, so
   * the cloud reads it as one of its own. None for one whose thread is gone, or that ran in no conversation the agent
   * named, which the cloud could not place.
   */
  private childOf(child: SubagentRecord, parentTurnId: string | null): Extract<ArrivalLine, { kind: "child" }> | null {
    const row = threads.get(this.deps.db, child.threadId);
    const parentSessionId = runs.get(this.deps.db, child.hostRunId)?.externalSessionId;
    if (!row || !parentSessionId) return null;
    return {
      kind: "child",
      id: child.threadId,
      title: row.title,
      settings: this.settingsOf(row),
      nativeId: child.nativeId,
      parentSessionId,
      agentType: child.agentType,
      toolCallId: child.toolCallId,
      prompt: child.prompt,
      status: CHILD_STATUS[child.status],
      result: child.result,
      error: null,
      parentTurnId,
      startedAt: new Date(child.startedAt).toISOString(),
      endedAt: child.endedAt === null ? null : new Date(child.endedAt).toISOString(),
    };
  }

  private async toMac(hosted: Hosted, move: CloudMove, local: Project): Promise<void> {
    const threadId = move.threadId;
    const row = hosted.threads.row!(threadId);
    const temp = await mkdtemp(path.join(os.tmpdir(), "openorc-move-"));
    let written = false;
    let switched = false;
    try {
      this.step(move, { step: "saving" });
      const work = await this.current(hosted, row.space, threadId);
      this.step(move, { step: "reading" });
      const read = await this.readFamily(hosted, row);
      this.step(move, { step: "writing" });
      written = true;
      for (const { one, under, session, runId, events } of read) {
        const here = this.writeHere(one.id, local, one, runId, events, session, under);
        await this.childrenHere(hosted, row.space, here, runId, events);
      }
      const thread = threads.get(this.deps.db, threadId)!;
      if (work.save?.bundle) await this.workHere(hosted, row.space, thread, local, work.save, temp);
      else await this.worktreeAt(thread, local, work.save?.base ?? null);
      await this.takeFamily(move, read);
      // Whole here, its reads come here from now on, while the server still has it, so none is caught between the two:
      // this Mac's list lets it go and every window reads it here. Then the server lets it go, and its family with it.
      cloudMoves.set(this.deps.db, move.id, { phase: "received", step: null });
      for (const { one } of read) hosted.threads.letGo?.(one.id);
      switched = true;
      for (const { one } of read) this.deps.placed(one.id);
      await hosted.moves.movedAway(row.space, threadId);
    } catch (error) {
      if (written) await this.deleteFamily(threadId).catch(() => undefined);
      // Still the cloud's: this Mac hears it again, and every window reads it there again.
      if (switched) {
        await hosted.threads.refresh?.().catch(() => undefined);
        for (const one of [{ id: threadId }, ...(hosted.threads.family?.(threadId) ?? [])]) this.deps.placed(one.id);
      }
      this.step(move, { phase: "abandoned", step: null, error: words(error), folder: error instanceof FolderInTheWay ? error.folder : null });
      this.deps.log.warn(`thread ${threadId} didn't move to ${this.deps.here.thisComputer}: ${logged(error)}`);
      return;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
    this.step(move, { phase: "done", step: null });
  }

  /**
   * The thread and every thread started under it, each after the one it was started under: their conversations and
   * their transcripts. Their work is the folder's, one for them all.
   */
  private async readFamily(hosted: Hosted, row: NonNullable<ReturnType<NonNullable<Hosted["threads"]["row"]>>>) {
    const family = hosted.threads.family?.(row.id) ?? [];
    const read = [];
    for (const { one, under } of [{ one: row, under: null }, ...family.map((member) => ({ one: member, under: member }))]) {
      const session = await this.savedSession(hosted, row.space, one.id, one.settings.agent);
      const runId = randomUUID();
      const events: AgentEvent[] = [];
      for await (const event of hosted.moves.events(row.space, one.id)) events.push({ ...event, runId } as AgentEvent);
      read.push({ one, under, session, runId, events });
    }
    return read;
  }

  /** Each thread of the family works in the thread's folder here, its agent's conversation taken there. */
  private async takeFamily(move: CloudMove, read: { one: { id: string }; session: PackedSession | null }[]): Promise<void> {
    const placed = threads.get(this.deps.db, move.threadId)!;
    for (const { one, session } of read) {
      const member = one.id === placed.id ? placed : threads.update(this.deps.db, one.id, { worktreePath: placed.worktreePath, branch: placed.branch, baseSha: placed.baseSha });
      if (session && placed.worktreePath)
        await this.deps.sessions.take({ id: member.id, agent: member.agent, claudeAccountId: member.claudeAccountId, children: [] }, session, placed.worktreePath, `cloud-${move.id}-${member.id}`);
    }
  }

  /** A thread whose cloud folder held nothing beyond its base works here from that base, in a worktree of its own. */
  private async worktreeAt(thread: Thread, project: Project, base: string | null): Promise<void> {
    const folder = this.deps.workspaces.threadPath(thread, project);
    if (await stat(folder).catch(() => null)) throw new FolderInTheWay(folder);
    const held = base !== null && (await git(project.rootPath, ["cat-file", "-e", `${base}^{commit}`], { okCodes: [0, 1, 128] })).code === 0;
    await this.deps.workspaces.prepareThread(thread, project, held ? base : undefined);
  }

  /** Has the thread leave its machine with a save, as Bring does, and answers that save once it is made. */
  private current(hosted: Hosted, space: string, threadId: string) {
    return hosted.macProjects.leave(space, threadId, CURRENT_MS);
  }

  /** The agent's saved conversation, unpacked; null when the thread has none yet. */
  private async savedSession(hosted: Hosted, space: string, threadId: string, agent: string): Promise<PackedSession | null> {
    const response = await hosted.moves.savedSession(space, threadId, agent, AbortSignal.timeout(CURRENT_MS));
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`OpenOrc Cloud didn't give the thread's conversation (${response.status}).`);
    return unpackSession(Buffer.from(await response.arrayBuffer()));
  }

  /**
   * The thread's rows here, under its cloud id: one run holding its transcript, carrying its conversation's id. One
   * started `under` another hangs under it as it did there, put away if the person had put it away.
   */
  private writeHere(
    threadId: string,
    local: Project,
    row: Pick<FamilyRow, "title" | "settings">,
    runId: string,
    events: AgentEvent[],
    session: PackedSession | null,
    under: Pick<FamilyRow, "parentId" | "startedByAgent" | "archivedAt"> | null,
  ): Thread {
    const settings = row.settings;
    const endedAt = events.at(-1)?.ts ?? (this.deps.now ?? Date.now)();
    this.deps.db.transaction(() => {
      threads.insert(this.deps.db, {
        id: threadId,
        projectId: local.id,
        title: row.title,
        agent: settings.agent,
        model: settings.model,
        effort: settings.effort,
        mode: settings.mode,
        permissionMode: settings.permissionMode,
        workspaceMode: "worktree",
        importedFrom: `cloud:${threadId}`,
      });
      if (under?.parentId)
        threads.update(this.deps.db, threadId, {
          parentThreadId: under.parentId,
          parentRelation: "started",
          startedByAgent: under.startedByAgent,
          archivedAt: under.archivedAt === null ? null : Date.parse(under.archivedAt),
        });
      runs.insert(this.deps.db, { id: runId, taskId: null, threadId, agent: settings.agent, model: settings.model, mode: settings.mode, permissionMode: settings.permissionMode });
      runs.update(this.deps.db, runId, { state: "success", externalSessionId: session?.sessionId ?? null, endedAt });
    });
    for (const event of events) this.deps.ledger.push(event);
    this.deps.ledger.flush();
    this.deps.db.stmt("UPDATE threads SET last_activity_at = ?, seen_at = ?, updated_at = ? WHERE id = ?").run(endedAt, endedAt, endedAt, threadId);
    return threads.get(this.deps.db, threadId)!;
  }

  /**
   * The cloud thread's subagents here as threads of their own, under their cloud ids, read from the cards in its events:
   * each with the agent's own name for it, what it was asked, how it ended and what it did, so a card opens its thread
   * here as it did there.
   */
  private async childrenHere(hosted: Hosted, space: string, root: Thread, rootRunId: string, events: readonly AgentEvent[]): Promise<void> {
    const cards = new Map<string, { started: Extract<AgentEvent, { type: "subagent.started" }>; updated: Extract<AgentEvent, { type: "subagent.updated" }> | null }>();
    for (const event of events) {
      if (event.type === "subagent.started" && event.threadId) cards.set(event.threadId, { started: event, updated: null });
      if (event.type === "subagent.updated" && event.threadId && cards.has(event.threadId)) cards.get(event.threadId)!.updated = event;
    }
    for (const [childId, { started, updated }] of cards) {
      const runId = randomUUID();
      const done: AgentEvent[] = [];
      for await (const event of hosted.moves.events(space, childId)) done.push({ ...event, runId } as AgentEvent);
      const status = updated?.status && updated.status !== "running" ? updated.status : "completed";
      const endedAt = updated?.ts ?? done.at(-1)?.ts ?? started.ts;
      this.deps.db.transaction(() => {
        threads.insert(this.deps.db, {
          id: childId,
          projectId: root.projectId,
          title: started.title,
          agent: root.agent,
          model: root.model,
          effort: root.effort,
          mode: root.mode,
          permissionMode: root.permissionMode,
          workspaceMode: root.workspaceMode,
        });
        threads.update(this.deps.db, childId, { parentThreadId: root.id, parentRelation: "subagent" });
        runs.insert(this.deps.db, { id: runId, taskId: null, threadId: childId, agent: root.agent, model: root.model, mode: root.mode, permissionMode: root.permissionMode });
        runs.update(this.deps.db, runId, { state: "success", endedAt });
        subagents.insert(this.deps.db, {
          threadId: childId,
          runId,
          hostRunId: rootRunId,
          rootThreadId: root.id,
          nativeId: started.subagentId,
          toolCallId: started.toolCallId ?? null,
          taskId: null,
          agentType: started.agentType ?? null,
          prompt: started.prompt ?? null,
          status,
          result: updated?.result ?? null,
          startedAt: started.ts,
          endedAt,
        });
      });
      for (const event of done) this.deps.ledger.push(event);
      this.deps.ledger.flush();
    }
  }

  /**
   * The thread's saved work in a worktree here: its commits into the project's folder as its branch, checked, then a
   * worktree on that branch with what it had not committed put back in its files. A folder of the thread's already here
   * is reused only when it is on that branch and holds nothing of its own.
   */
  private async workHere(hosted: Hosted, space: string, thread: Thread, project: Project, save: { branch: string | null; head: string; base: string }, temp: string): Promise<void> {
    const response = await hosted.macProjects.bundle(space, thread.id, AbortSignal.timeout(CURRENT_MS));
    if (!response.ok) throw new Error(`OpenOrc Cloud didn't give the thread's saved work (${response.status}).`);
    const file = path.join(temp, "work.bundle");
    await writeFile(file, Buffer.from(await response.arrayBuffer()));
    const placed = await bringIntoFolder(project.rootPath, file, save);
    const wip =
      (await git(project.rootPath, ["bundle", "list-heads", file])).stdout
        .split("\n")
        .find((line) => line.endsWith(" refs/openorc/saved/wip"))
        ?.split(" ")[0] ?? null;
    const named = threads.update(this.deps.db, thread.id, { branch: placed.branch, baseSha: save.base });
    const folder = this.deps.workspaces.threadPath(named, project);
    if (await stat(folder).catch(() => null)) {
      const branch = (await git(folder, ["symbolic-ref", "--quiet", "--short", "HEAD"], { okCodes: [0, 1, 128] })).stdout.trim();
      const changed = (await git(folder, ["status", "--porcelain"], { okCodes: [0, 128] })).stdout.trim();
      if (branch !== placed.branch || changed) throw new FolderInTheWay(folder);
      threads.update(this.deps.db, thread.id, { worktreePath: folder });
    } else {
      await this.deps.workspaces.prepareThread(named, project, placed.branch);
    }
    const ready = threads.get(this.deps.db, thread.id)!;
    if (wip && ready.worktreePath) await git(ready.worktreePath, ["restore", `--source=${wip}`, "--worktree", "--", "."]);
  }

  /**
   * Picks up every move under way when OpenOrc starts. Nothing of a move runs across a restart: one that stopped before
   * its commit point is undone, and one past it is finished.
   */
  async resume(): Promise<void> {
    const hosted = this.deps.hosted();
    const open = cloudMoves.allOpen(this.deps.db);
    if (!open.length) return;
    // Whether a move got past the server's done is read from the server's list as it stands now.
    if (hosted?.spaces.status().state === "ready") await hosted.threads.refresh?.().catch(() => undefined);
    for (const move of open) {
      const reason = "This move stopped when OpenOrc closed. Try again.";
      try {
        if (move.direction === "to-cloud") {
          if (hosted?.threads.holds({ thread: move.threadId })) {
            cloudMoves.set(this.deps.db, move.id, { phase: "done", step: null });
            await this.deleteFamily(move.threadId).catch(() => undefined);
          } else {
            const status = hosted?.spaces.status();
            const space = move.projectId && hosted?.threads.cloudProjectFor?.(move.projectId)?.space;
            if (move.phase === "sending" && hosted && space && status?.state === "ready") await hosted.moves.undo(space, move.threadId).catch(() => undefined);
            cloudMoves.set(this.deps.db, move.id, { phase: "abandoned", step: null, error: reason });
          }
        } else if (move.phase === "received" && !hosted?.threads.holds({ thread: move.threadId })) {
          cloudMoves.set(this.deps.db, move.id, { phase: "done", step: null });
        } else {
          if (move.phase === "received") await this.deleteFamily(move.threadId).catch(() => undefined);
          cloudMoves.set(this.deps.db, move.id, { phase: "abandoned", step: null, error: reason });
        }
      } catch (error) {
        this.deps.log.warn(`a move of thread ${move.threadId} couldn't be picked up: ${logged(error)}`);
      }
      this.deps.changed(move.threadId);
    }
  }
}
