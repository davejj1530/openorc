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
 *                  until the server lets the cloud thread go
 *
 * This Mac's journal (`cloudMoves`, thread_relocations) says where each move stands. A move that stops before its
 * commit point is undone, the thread stays where it was, and its place row says why ("Didn't move: …").
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { packSession, SessionRefused, unpackSession, type PackedSession } from "@openorc/agents";
import { cloudMoves, listEvents, orclings, projects, runs, threads, type CloudMove, type Db, type LedgerWriter } from "@openorc/db";
import { bringIntoFolder, git } from "@openorc/git";
import type { ArrivalLine, ArrivalSettings, Hosted } from "@openorc/hosted";
import { harnessShortName, isHostedAgent, movingHold, WORKSPACE_ID, type AgentEvent, type CloudMoveCheck, type CloudMoveStart, type Project, type Thread, type ThreadMoving } from "@openorc/protocol";
import type { AgentSessions } from "./agent-sessions.js";
import { packProject, uploadOf } from "./mac-work.js";
import type { WorkspaceService } from "./workspace.js";

const WORKING = "The agent is still working. Move it once it stops.";
const NOT_IN_CLOUD = "Add this project to OpenOrc Cloud in Settings first.";
const SIGN_IN = "Sign in to OpenOrc to move this thread.";
const ONLY_OWN_SPACE = "Only a thread in your own space can move to this Mac.";
const NOT_HERE = "This project isn't on this Mac.";
/** How long a move to this Mac waits for the thread to leave its cloud machine with a save. */
const CURRENT_MS = 3 * 60_000;
/** How long a move to the cloud waits to hear the cloud thread before it lets the Mac's go. */
const HEARD_MS = 30_000;

const words = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
  /** The thread's place changed: its lists and its own view read it again. */
  changed(threadId: string): void;
  /** This Mac's name, for what a move to it says. */
  machine: string;
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
    const moving = movingHold(this.moving(threadId), this.deps.machine);
    if (moving) return held(moving);
    if (!hosted || hosted.spaces.status().state !== "ready") return held(SIGN_IN);
    if (!isHostedAgent(thread.agent)) return held(`${harnessShortName(thread.agent)} doesn't run on OpenOrc Cloud.`);
    if (runs.listForThread(this.deps.db, threadId).some((run) => run.state === "starting" || run.state === "running")) return held(WORKING);
    const cloud = hosted.threads.cloudProjectFor?.(thread.projectId);
    if (!cloud) return held(NOT_IN_CLOUD);
    const status = hosted.spaces.status();
    return { to: "cloud", can: true, space: { id: cloud.space, personal: status.state === "ready" && status.personalSpaceId === cloud.space } };
  }

  private async checkToMac(hosted: Hosted, threadId: string): Promise<CloudMoveCheck> {
    const held = (reason: string): CloudMoveCheck => ({ to: "mac", can: false, reason });
    const row = hosted.threads.row!(threadId);
    const status = hosted.spaces.status();
    const moving = movingHold(this.moving(threadId), this.deps.machine);
    if (moving) return held(moving);
    if (status.state !== "ready" || row.space !== status.personalSpaceId) return held(ONLY_OWN_SPACE);
    const local = this.localProjectOf(hosted, threadId);
    if (!local) return held(NOT_HERE);
    try {
      this.deps.sessions.assertTakeable({ id: threadId, agent: row.settings.agent, claudeAccountId: null, children: [] });
    } catch (error) {
      if (error instanceof SessionRefused) return held(error.message);
      throw error;
    }
    const work = await hosted.macProjects.workSave(row.space, threadId);
    if (work.working) return held(WORKING);
    return { to: "mac", can: true, ends: work.current ? [] : work.ends };
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
      const session = await this.deps.sessions.export(thread);
      const folder = thread.worktreePath ?? projects.get(this.deps.db, thread.projectId)?.rootPath;
      const pack = thread.baseSha && folder ? await packProject(this.deps.db, thread.projectId, [], folder) : null;
      const packed = pack && uploadOf(pack);
      if (packed?.refusal) {
        await packed.done();
        throw new Error(packed.refusal);
      }
      const upload = packed && packed.refusal === null ? packed : null;
      this.step(move, { phase: "sending", step: "history" });
      await hosted.moves.arrive(space, { id: thread.id, projectId: cloud.id, title: thread.title, settings: this.settingsOf(thread) });
      made = true;
      await hosted.moves.history(space, thread.id, () => this.historyOf(thread));
      if (session) {
        this.step(move, { step: "conversation" });
        await hosted.moves.session(space, thread.id, { agent: session.agent, sessionId: session.sessionId, cliVersion: session.cliVersion }, packSession(session));
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
      this.deps.log.warn(`thread ${thread.id} didn't move to OpenOrc Cloud: ${words(error)}`);
      return;
    }
    // The commit point is passed: the cloud thread is whole. Let the Mac's go once the cloud's is heard, so the thread is
    // never in neither list.
    await this.heard(hosted, thread.id);
    this.step(move, { phase: "done", step: null });
    await this.deps.deleteThread(thread.id).catch((error: unknown) => this.deps.log.warn(`thread ${thread.id} moved to OpenOrc Cloud and its copy here couldn't be deleted: ${words(error)}`));
    this.deps.changed(thread.id);
  }

  /** Waits a while for this Mac to hear the cloud thread it just made, reading the server again meanwhile. */
  private async heard(hosted: Hosted, threadId: string): Promise<void> {
    const until = (this.deps.now ?? Date.now)() + HEARD_MS;
    const known = () => hosted.threads.holds({ thread: threadId });
    while (!known() && (this.deps.now ?? Date.now)() < until) {
      await hosted.threads.refresh?.().catch(() => undefined);
      if (!known()) await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  /** The thread's transcript as the arrival takes it: each person's message and what followed it, as one turn. */
  private async *historyOf(thread: Thread): AsyncGenerator<ArrivalLine> {
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

  private async toMac(hosted: Hosted, move: CloudMove, local: Project): Promise<void> {
    const threadId = move.threadId;
    const row = hosted.threads.row!(threadId);
    const temp = await mkdtemp(path.join(os.tmpdir(), "openorc-move-"));
    let written = false;
    try {
      this.step(move, { step: "saving" });
      const work = await this.current(hosted, row.space, threadId);
      this.step(move, { step: "reading" });
      const session = await this.savedSession(hosted, row.space, threadId, row.settings.agent);
      const events: AgentEvent[] = [];
      const runId = randomUUID();
      for await (const event of hosted.moves.events(row.space, threadId)) events.push({ ...event, runId } as AgentEvent);
      this.step(move, { step: "writing" });
      const thread = this.writeHere(threadId, local, row, runId, events, session);
      written = true;
      if (work.save?.bundle) await this.workHere(hosted, row.space, thread, local, work.save, temp);
      const placed = threads.get(this.deps.db, threadId)!;
      if (session && placed.worktreePath)
        await this.deps.sessions.take({ id: threadId, agent: placed.agent, claudeAccountId: placed.claudeAccountId, children: [] }, session, placed.worktreePath, `cloud-${move.id}`);
      this.step(move, { phase: "received", step: null });
      await hosted.moves.movedAway(row.space, threadId);
    } catch (error) {
      if (written) await this.deps.deleteThread(threadId).catch(() => undefined);
      this.step(move, { phase: "abandoned", step: null, error: words(error) });
      this.deps.log.warn(`thread ${threadId} didn't move to ${this.deps.machine}: ${words(error)}`);
      return;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
    this.step(move, { phase: "done", step: null });
    await hosted.threads.refresh?.();
    this.deps.changed(threadId);
  }

  /** Has the thread leave its machine with a save, as Bring does, and answers that save once it is current. */
  private async current(hosted: Hosted, space: string, threadId: string) {
    let work = await hosted.macProjects.workSave(space, threadId);
    if (work.current) return work;
    await hosted.macProjects.ask(space, threadId);
    const until = (this.deps.now ?? Date.now)() + CURRENT_MS;
    while (!work.current) {
      if ((this.deps.now ?? Date.now)() > until) throw new Error("The thread didn't leave its cloud machine in time. Try again.");
      await new Promise((resolve) => setTimeout(resolve, 1000));
      work = await hosted.macProjects.workSave(space, threadId);
    }
    return work;
  }

  /** The agent's saved conversation, unpacked; null when the thread has none yet. */
  private async savedSession(hosted: Hosted, space: string, threadId: string, agent: string): Promise<PackedSession | null> {
    const response = await hosted.moves.savedSession(space, threadId, agent, AbortSignal.timeout(CURRENT_MS));
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`OpenOrc Cloud didn't give the thread's conversation (${response.status}).`);
    return unpackSession(Buffer.from(await response.arrayBuffer()));
  }

  /** The thread's rows here, under its cloud id: one run holding its transcript, carrying its conversation's id. */
  private writeHere(threadId: string, local: Project, row: NonNullable<ReturnType<NonNullable<Hosted["threads"]["row"]>>>, runId: string, events: AgentEvent[], session: PackedSession | null): Thread {
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
      runs.insert(this.deps.db, { id: runId, taskId: null, threadId, agent: settings.agent, model: settings.model, mode: settings.mode, permissionMode: settings.permissionMode });
      runs.update(this.deps.db, runId, { state: "success", externalSessionId: session?.sessionId ?? null, endedAt });
    });
    for (const event of events) this.deps.ledger.push(event);
    this.deps.ledger.flush();
    this.deps.db.stmt("UPDATE threads SET last_activity_at = ?, seen_at = ?, updated_at = ? WHERE id = ?").run(endedAt, endedAt, endedAt, threadId);
    return threads.get(this.deps.db, threadId)!;
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
      if (branch !== placed.branch || changed) throw new Error(`A folder for this thread is already at ${folder} with other work in it. Move that work aside, then try again.`);
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
            await this.deps.deleteThread(move.threadId).catch(() => undefined);
          } else {
            const status = hosted?.spaces.status();
            const space = move.projectId && hosted?.threads.cloudProjectFor?.(move.projectId)?.space;
            if (move.phase === "sending" && hosted && space && status?.state === "ready") await hosted.moves.undo(space, move.threadId).catch(() => undefined);
            cloudMoves.set(this.deps.db, move.id, { phase: "abandoned", step: null, error: reason });
          }
        } else if (move.phase === "received" && !hosted?.threads.holds({ thread: move.threadId })) {
          cloudMoves.set(this.deps.db, move.id, { phase: "done", step: null });
        } else {
          if (move.phase === "received") await this.deps.deleteThread(move.threadId).catch(() => undefined);
          cloudMoves.set(this.deps.db, move.id, { phase: "abandoned", step: null, error: reason });
        }
      } catch (error) {
        this.deps.log.warn(`a move of thread ${move.threadId} couldn't be picked up: ${words(error)}`);
      }
      this.deps.changed(move.threadId);
    }
  }
}
