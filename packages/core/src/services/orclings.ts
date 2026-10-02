import { randomUUID } from "node:crypto";
import { audit, orchestration, orclings, runs as runRepo, tasks, threads, type Db } from "@openorc/db";
import {
  isHarnessId,
  orclingExecution,
  orclingHandle,
  stricterPermission,
  WORKSPACE_ID,
  type Orcling,
  type OrclingDraft,
  type OrclingInstructionsVersion,
  type PermissionPreset,
  type Run,
  type RunMode,
  type Thread,
} from "@openorc/protocol";
import { AttachmentService } from "./attachments.js";
import type { MemoryService } from "./memory.js";
import { catchUp, orclingBrief, rolloverSeed, type OrclingPlace } from "./orcling-briefs.js";
import { OrclingFolders } from "./orcling-folders.js";
import type { OrclingRunHooks, StartRunInput } from "./run-types.js";
import type { RunService } from "./runs.js";
import type { ThreadService } from "./threads.js";
import type { StartThreadInput, ThreadPatch } from "./thread-inputs.js";
import { executionProject } from "./workspace-home.js";

/** A new session of an Orcling's own conversation starts after this long without a turn. */
export const ORCLING_QUIET_MS = 6 * 60 * 60 * 1000;
/** Or once the session fills this much of the model's context window. */
export const ORCLING_FULL_CONTEXT = 0.7;

const STARTER_INSTRUCTIONS = `# How I work with you

- Be warm, direct and brief. Lead with the answer.
- Ask when something is unclear instead of guessing.
- Remember what matters to you, and use it without being asked.
- Rewrite these instructions as I learn how you like to work.`;

interface Dependencies {
  db: Db;
  dataDir: string;
  memory: Pick<MemoryService, "orclingBrief" | "listOrcling" | "remove">;
  /** Resolved when used: the run and thread services start after this one, because they launch with its hooks. */
  runs: () => Pick<RunService, "liveRunForThread" | "closeAndWait" | "threadContext" | "threadActivity" | "start">;
  threads: () => Pick<ThreadService, "delete" | "start" | "update" | "taskThreadForStart" | "startTaskInThread">;
  invalidate: (keys: string[]) => void;
}

/**
 * Orclings: saved identities with a look, a model, a permission, their own
 * instructions and memory, and one personal conversation in the Workspace.
 * Wherever an Orcling works, its runs carry its identity: this service says
 * who speaks in a run, what it is told, and when its own conversation starts
 * a fresh session.
 */
export class OrclingService {
  private readonly folders: OrclingFolders;

  constructor(private readonly deps: Dependencies) {
    this.folders = new OrclingFolders(deps.dataDir);
  }

  list(): Orcling[] {
    return orclings.list(this.deps.db);
  }

  get(id: string): Orcling {
    const orcling = orclings.get(this.deps.db, id);
    if (!orcling) throw new Error("This Orcling no longer exists.");
    return orcling;
  }

  async create(draft: OrclingDraft): Promise<Orcling> {
    const { db } = this.deps;
    this.assertNameFree(draft.name, null);
    const id = randomUUID();
    const folder = await this.folders.create(draft.name);
    const execution = orclingExecution(draft);
    const orcling = db.transaction(() => {
      // Again beside the insert: another Orcling may have taken the name while its folder was made.
      this.assertNameFree(draft.name, null);
      const home = threads.insert(db, {
        projectId: WORKSPACE_ID,
        title: draft.name,
        agent: draft.settings.agent,
        model: draft.settings.model,
        effort: draft.settings.effort,
        fastMode: draft.settings.fastMode,
        ...execution,
      });
      threads.update(db, home.id, { workingDirectory: folder });
      const created = orclings.insert(db, { id, draft, threadId: home.id });
      threads.update(db, home.id, { orclingId: id });
      orclings.appendInstructions(db, id, { body: STARTER_INSTRUCTIONS, author: "user", note: "Starter instructions" });
      audit.record(db, { actor: "user", action: "orcling.create", resourceType: "orcling", resourceId: id, metadata: { agent: draft.settings.agent, threadId: home.id } });
      return created;
    });
    this.changed(orcling);
    return orcling;
  }

  async update(id: string, draft: OrclingDraft): Promise<Orcling> {
    const { db } = this.deps;
    const current = this.get(id);
    this.assertNameFree(draft.name, id);
    const folder = await this.renameFolder(current, draft.name);
    const orcling = db.transaction(() => {
      const updated = orclings.update(db, id, draft)!;
      threads.update(db, updated.threadId, {
        ...(folder ? { workingDirectory: folder } : {}),
        title: updated.name,
        agent: updated.settings.agent,
        model: updated.settings.model,
        effort: updated.settings.effort,
        fastMode: updated.settings.fastMode,
        ...orclingExecution(updated),
      });
      this.clampThreads(updated);
      audit.record(db, { actor: "user", action: "orcling.update", resourceType: "orcling", resourceId: id, metadata: { agent: updated.settings.agent, permission: updated.permission } });
      return updated;
    });
    this.changed(orcling);
    return orcling;
  }

  /** Its folder follows a new name, between turns. Returns where it moved, or null when it stays. */
  private async renameFolder(orcling: Orcling, name: string): Promise<string | null> {
    const home = threads.get(this.deps.db, orcling.threadId);
    const to = await this.folders.destination(home?.workingDirectory, name);
    if (!to) return null;
    if (this.deps.runs().threadActivity(orcling.threadId) !== "idle") throw new Error(`Wait for ${orcling.name} to finish before renaming it.`);
    return this.folders.move(home!.workingDirectory!, to);
  }

  /** Removes the Orcling, its instructions, memories and conversation. Threads it worked in keep their history. */
  async delete(id: string): Promise<void> {
    const { db } = this.deps;
    const orcling = this.get(id);
    const folder = threads.get(db, orcling.threadId)?.workingDirectory;
    const live = this.deps.runs().liveRunForThread(orcling.threadId);
    if (live) await this.deps.runs().closeAndWait(live.id);
    for (const memory of this.deps.memory.listOrcling(id, { limit: 10_000 })) this.deps.memory.remove(memory.id);
    db.transaction(() => {
      orclings.delete(db, id);
      audit.record(db, { actor: "user", action: "orcling.delete", resourceType: "orcling", resourceId: id, metadata: { threadId: orcling.threadId } });
    });
    await this.deps.threads().delete(orcling.threadId);
    await this.folders.removeIfEmpty(folder);
    this.deps.invalidate(["orclings", "threads", `thread:${orcling.threadId}`, `memory:orcling:${id}`]);
  }

  instructions(id: string): OrclingInstructionsVersion[] {
    this.get(id);
    return orclings.instructions(this.deps.db, id);
  }

  saveInstructions(id: string, body: string, author: "user" | "orcling", note: string | null): OrclingInstructionsVersion {
    this.get(id);
    const saved = orclings.appendInstructions(this.deps.db, id, { body, author, note });
    audit.record(this.deps.db, { actor: author === "user" ? "user" : "agent", action: "orcling.instructions", resourceType: "orcling", resourceId: id, metadata: { version: saved.version } });
    this.deps.invalidate(["orclings"]);
    return saved;
  }

  restoreInstructions(id: string, version: number): OrclingInstructionsVersion {
    const earlier = this.instructions(id).find((entry) => entry.version === version);
    if (!earlier) throw new Error(`Version ${version} of these instructions does not exist.`);
    return this.saveInstructions(id, earlier.body, "user", `Restored version ${version}`);
  }

  /** A project conversation the Orcling works in, from its first message. Its own conversation is where you talk to it outside projects. */
  async startThread(id: string, input: Omit<StartThreadInput, "agent" | "model" | "effort" | "fastMode">) {
    const orcling = this.get(id);
    if (input.projectId === WORKSPACE_ID) throw new Error(`Talk to ${orcling.name} in its own conversation, or start this in a project.`);
    const ceiling = orclingExecution(orcling);
    const { agent, model, effort, fastMode } = orcling.settings;
    return this.deps.threads().start(
      {
        ...input,
        agent,
        model,
        effort: effort ?? undefined,
        fastMode,
        mode: ceiling.mode === "plan" ? "plan" : input.mode,
        permissionMode: stricterPermission(input.permissionMode, ceiling.permissionMode),
      },
      { assertCanAdmit: () => undefined, onAdmitted: (thread) => threads.update(this.deps.db, thread.id, { orclingId: id }) },
    );
  }

  /**
   * An Orcling takes up a saved task in a thread of its own, on its own model and within its permission. A task
   * that already has a conversation of someone else's stays there.
   */
  async startTask(id: string, taskId: string, input: { mode: RunMode; permissionMode: PermissionPreset; prompt: string; promptRole?: "user" | "system" }): Promise<Run> {
    const { db } = this.deps;
    const orcling = this.get(id);
    const task = tasks.get(db, taskId);
    if (!task) throw new Error("No such task.");
    const current = [task.executionThreadId, task.threadId].map((threadId) => (threadId ? threads.get(db, threadId) : null)).find(Boolean);
    if (current && current.orclingId !== id) throw new Error(`This task already has a conversation, "${current.title}". Message it with orcling_thread_send instead.`);
    const ceiling = orclingExecution(orcling);
    const { agent, model, effort, fastMode } = orcling.settings;
    const thread = this.deps.threads().taskThreadForStart(taskId, { agent, model, effort });
    if (thread.orclingId !== id) threads.update(db, thread.id, { orclingId: id });
    const images = await new AttachmentService(this.deps.dataDir).forTask(task.spec ?? "");
    return this.deps.threads().startTaskInThread(taskId, undefined, images, {
      agent,
      model,
      effort: effort ?? undefined,
      fastMode,
      mode: ceiling.mode === "plan" ? "plan" : input.mode,
      permissionMode: stricterPermission(input.permissionMode, ceiling.permissionMode),
      prompt: input.prompt,
      ...(input.promptRole ? { promptRole: input.promptRole } : {}),
      attachments: undefined,
    });
  }

  /** An Orcling answers in a conversation that belongs to another agent, without taking it over. */
  async ask(id: string, threadId: string, prompt: string, attachments: string[] | undefined): Promise<Run> {
    const orcling = this.get(id);
    const thread = this.guestThread(orcling, threadId);
    if (this.deps.runs().threadActivity(threadId) !== "idle") throw new Error(`Wait for the current turn to finish, then ask ${orcling.name}.`);
    const { agent, model, effort, fastMode } = orcling.settings;
    return this.deps.runs().start({
      scope: { task: null, thread },
      project: executionProject(this.deps.db, thread),
      agent,
      model,
      effort: effort ?? undefined,
      fastMode,
      attachments,
      mode: thread.mode,
      permissionMode: thread.permissionMode,
      prompt,
      resume: true,
      orclingId: orcling.id,
    });
  }

  private guestThread(orcling: Orcling, threadId: string): Thread {
    const thread = threads.get(this.deps.db, threadId);
    if (!thread) throw new Error("This conversation no longer exists.");
    if (thread.orclingId === orcling.id) throw new Error(`${orcling.name} already works in this conversation. Message it without a mention.`);
    if (orchestration.getInstance(this.deps.db, threadId)) throw new Error(`Team conversations speak with their members. Add ${orcling.name} to the team instead.`);
    if (orclings.forThread(this.deps.db, threadId)) throw new Error("Another Orcling's own conversation is only for that Orcling.");
    return thread;
  }

  /** Gives a project conversation to an Orcling, which takes over its model, or with null returns it to a plain model. */
  assign(threadId: string, orclingId: string | null): void {
    const thread = threads.get(this.deps.db, threadId);
    if (!thread) throw new Error("This conversation no longer exists.");
    if (thread.projectId === WORKSPACE_ID || orclings.forThread(this.deps.db, threadId) || orchestration.getInstance(this.deps.db, threadId)) {
      throw new Error("Only a project conversation can be given to an Orcling.");
    }
    const orcling = orclingId ? this.get(orclingId) : null;
    if (orcling) {
      const { agent, model, effort, fastMode } = orcling.settings;
      const ceiling = orclingExecution(orcling);
      this.deps.threads().update(threadId, {
        agent,
        model,
        effort,
        fastMode,
        mode: ceiling.mode === "plan" ? "plan" : thread.mode,
        permissionMode: stricterPermission(thread.permissionMode, ceiling.permissionMode),
      });
    }
    threads.update(this.deps.db, threadId, { orclingId });
    this.deps.invalidate(["threads", `thread:${threadId}`]);
  }

  /**
   * A change to a conversation an Orcling works in: never looser than the Orcling allows. In the Orcling's own
   * conversation, a new model is the Orcling's new model, and the conversation stays where it is.
   */
  threadPatch(threadId: string, patch: ThreadPatch): ThreadPatch {
    const thread = threads.get(this.deps.db, threadId);
    const orcling = thread?.orclingId ? orclings.get(this.deps.db, thread.orclingId) : null;
    if (!thread || !orcling) return patch;
    const home = orcling.threadId === thread.id;
    if (home && patch.archived) throw new Error(`This is ${orcling.name}'s own conversation, so it stays open.`);
    const ceiling = orclingExecution(orcling);
    const clamped = {
      ...patch,
      ...(patch.mode && ceiling.mode === "plan" ? { mode: "plan" as const } : {}),
      ...(patch.permissionMode ? { permissionMode: stricterPermission(patch.permissionMode, ceiling.permissionMode) } : {}),
    };
    if (home && (patch.agent || patch.model !== undefined || patch.effort !== undefined || patch.fastMode !== undefined)) this.adoptThreadModel(orcling, patch);
    return clamped;
  }

  private adoptThreadModel(orcling: Orcling, patch: ThreadPatch): void {
    const settings = {
      agent: patch.agent && isHarnessId(patch.agent) ? patch.agent : orcling.settings.agent,
      model: patch.model ?? orcling.settings.model,
      effort: patch.effort === undefined ? orcling.settings.effort : patch.effort,
      fastMode: patch.fastMode ?? orcling.settings.fastMode,
    };
    const updated = orclings.update(this.deps.db, orcling.id, { ...orcling, settings });
    if (updated) this.changed(updated);
  }

  /** The Orcling whose own conversation this is. */
  forThread(threadId: string): Orcling | null {
    return orclings.forThread(this.deps.db, threadId);
  }

  /** How an Orcling's identity joins the runs it speaks in. */
  readonly runHooks: OrclingRunHooks = {
    prepare: (input) => this.prepare(input),
    brief: (input) => this.brief(input),
    rolloverDue: (thread) => this.rolloverDue(thread),
    ceiling: (orclingId) => {
      const ceiling = orclingExecution(this.get(orclingId));
      return ceiling.mode === "plan" ? "review" : ceiling.permissionMode;
    },
  };

  private identity(input: StartRunInput): string | null {
    // The stored row, not the caller's copy: a conversation may have been given its Orcling while it was admitted.
    const thread = input.scope.thread ? threads.get(this.deps.db, input.scope.thread.id) : null;
    const wanted = input.orclingId ?? thread?.orclingId ?? null;
    return wanted && orclings.get(this.deps.db, wanted) ? wanted : null;
  }

  private prepare(input: StartRunInput): StartRunInput {
    const orclingId = this.identity(input);
    const prepared = orclingId ? this.asOrcling(this.get(orclingId), input) : { ...input, orclingId: undefined };
    const thread = prepared.scope.thread;
    if (!thread || prepared.handoff) return prepared;
    const heard = catchUp(this.deps.db, thread, prepared.orclingId ?? null, (other) => this.name(other));
    return heard ? { ...prepared, handoff: heard } : prepared;
  }

  /** An Orcling never works more freely than its permission, and its own conversation starts fresh when a session is due. */
  private asOrcling(orcling: Orcling, input: StartRunInput): StartRunInput {
    const ceiling = orclingExecution(orcling);
    const mode: RunMode = input.mode === "plan" || ceiling.mode === "plan" ? "plan" : "act";
    const permissionMode: PermissionPreset = mode === "plan" ? "review" : stricterPermission(input.permissionMode, ceiling.permissionMode);
    const prepared = { ...input, orclingId: orcling.id, mode, permissionMode };
    const thread = input.scope.thread;
    if (!thread || thread.id !== orcling.threadId || !input.resume || !this.rolloverDue(thread)) return prepared;
    return { ...prepared, resume: false, resumeFrom: undefined, handoff: rolloverSeed(this.deps.db, thread, (other) => this.name(other)) };
  }

  private brief(input: StartRunInput): string {
    const orcling = input.orclingId ? orclings.get(this.deps.db, input.orclingId) : null;
    if (!orcling) return "";
    const instructions = orclings.currentInstructions(this.deps.db, orcling.id)?.body ?? "";
    return orclingBrief(orcling, { instructions, memory: this.deps.memory.orclingBrief(orcling.id), place: this.place(orcling, input), tools: !input.scope.comment });
  }

  private place(orcling: Orcling, input: StartRunInput): OrclingPlace {
    const thread = input.scope.thread ? threads.get(this.deps.db, input.scope.thread.id) : null;
    if (!thread || input.teamAttemptId) return "elsewhere";
    if (thread.id === orcling.threadId) return "home";
    return thread.orclingId === orcling.id ? "thread" : "guest";
  }

  /** Whether an Orcling's own conversation should start a new session: quiet for hours, or its context mostly full. */
  private rolloverDue(thread: Thread): boolean {
    if (!orclings.forThread(this.deps.db, thread.id)) return false;
    // A session begun in another folder, before a rename, cannot go on in this one.
    const lastFolder = this.deps.db.stmt("SELECT working_directory FROM runs WHERE thread_id = ? ORDER BY started_at DESC LIMIT 1").get(thread.id) as { working_directory: string | null } | undefined;
    if (lastFolder?.working_directory && thread.workingDirectory && lastFolder.working_directory !== thread.workingDirectory) return true;
    const last = this.deps.db.stmt("SELECT MAX(e.ts) AS ts FROM events e JOIN runs r ON r.id = e.run_id WHERE r.thread_id = ? AND e.kind = 'turn.completed'").get(thread.id) as
      { ts: number | null } | undefined;
    if (!last?.ts) return false;
    if (Date.now() - last.ts >= ORCLING_QUIET_MS) return true;
    const context = this.deps.runs().threadContext(thread.id);
    return Boolean(context?.window && context.used / context.window >= ORCLING_FULL_CONTEXT);
  }

  /** Threads an Orcling works in never keep a looser permission than the Orcling's own. */
  private clampThreads(orcling: Orcling): void {
    const ceiling = orclingExecution(orcling);
    const rows = this.deps.db.stmt("SELECT id FROM threads WHERE orcling_id = ? AND id != ?").all(orcling.id, orcling.threadId) as { id: string }[];
    for (const { id } of rows) {
      const thread = threads.get(this.deps.db, id);
      if (!thread) continue;
      const permissionMode = stricterPermission(thread.permissionMode, ceiling.permissionMode);
      const mode = ceiling.mode === "plan" ? "plan" : thread.mode;
      if (permissionMode !== thread.permissionMode || mode !== thread.mode) threads.update(this.deps.db, id, { permissionMode, mode });
    }
  }

  /** Mentions find an Orcling by name and its folder is named after it, so no two share a name, whatever the case or punctuation. */
  private assertNameFree(name: string, except: string | null): void {
    const handle = orclingHandle(name);
    const taken = this.list().find((other) => other.id !== except && orclingHandle(other.name) === handle);
    if (taken) throw new Error(`You already have an Orcling named ${taken.name}.`);
  }

  private name(orclingId: string): string | null {
    return orclings.get(this.deps.db, orclingId)?.name ?? null;
  }

  private changed(orcling: Orcling): void {
    this.deps.invalidate(["orclings", "threads", `thread:${orcling.threadId}`, `orcling:${orcling.id}`]);
  }

  /** Every memory an Orcling holds, for its profile. */
  memories(id: string) {
    this.get(id);
    return this.deps.memory.listOrcling(id, { limit: 500 });
  }

  /** Which Orcling learns from a finished run: only its own conversation feeds its memory automatically. */
  memoryOwner(run: { orclingId?: string | null }, thread: Thread | null): string | null {
    return run.orclingId && thread && orclings.get(this.deps.db, run.orclingId)?.threadId === thread.id ? run.orclingId : null;
  }

  /** Whether a run speaks as an Orcling, and which one. */
  forRun(runId: string): Orcling | null {
    const orclingId = runRepo.get(this.deps.db, runId)?.orclingId;
    return orclingId ? orclings.get(this.deps.db, orclingId) : null;
  }
}
