import { runs, threads, type Db } from "@openorc/db";
import { randomUUID } from "node:crypto";
import { type LiveSettings } from "@openorc/agents";
import { type AgentEvent, type AgentKind, type Run, type Thread } from "@openorc/protocol";
import type { Logger } from "../transport.js";
import type { ContinueSettings, LiveRun, RunHooks, RunScope, SendOptions, StartRunInput } from "./run-types.js";
import { executionProject } from "./workspace-home.js";

/** Settings fixed at process launch must match before another turn can reuse it. */
export function matchesContinueSettings(entry: LiveRun, desired: ContinueSettings): boolean {
  const launched = entry.run.mode === "plan" ? entry.run.permissionMode : entry.providerPermissionMode;
  if (entry.run.agent !== desired.agent || entry.run.mode !== desired.mode) return false;
  if (launched !== desired.permissionMode) return false;
  if ((entry.run.effort ?? null) !== (desired.effort ?? null)) return false;
  if (Boolean(entry.run.fastMode) !== Boolean(desired.fastMode)) return false;
  if (desired.model !== null && desired.model !== undefined && entry.run.model !== desired.model) return false;
  return true;
}

/** Sending a turn either retains the live process or starts a compatible replacement. */
interface RunTurnsDependencies {
  db: Db;
  live: ReadonlyMap<string, LiveRun>;
  compactions: ReadonlyMap<string, Promise<void>>;
  isClosing: () => boolean;
  hooks: Pick<RunHooks, "assertSend" | "orclings">;
  resetAgentChain: (threadId: string) => void;
  disarmIdle: (runId: string) => void;
  armIdle: (entry: LiveRun) => void;
  invalidate: (keys: string[]) => void;
  keysFor: (scope: RunScope) => string[];
  start: (input: StartRunInput) => Promise<Run>;
  emit: (event: AgentEvent) => void;
  validateFastMode: (agent: AgentKind, model: string | undefined, fastMode: boolean | undefined) => Promise<void>;
  log: Logger;
}

export class RunTurns {
  constructor(private readonly deps: RunTurnsDependencies) {}

  async sendTurn(runId: string, text: string, options: SendOptions): Promise<void> {
    const { role = "user" } = options;
    this.deps.hooks.assertSend?.(runId, options.teamAttemptId);
    const threadId = this.deps.live.get(runId)?.scope.thread?.id;
    if (role === "user" && threadId) this.deps.resetAgentChain(threadId);
    if (this.deps.isClosing()) throw new Error("OpenOrc is closing.");
    const compact = this.deps.compactions.get(runId);
    if (compact) await compact;
    const entry = this.deps.live.get(runId);
    if (!entry) throw new Error(`run ${runId} is not live`);
    const thread = entry.scope.thread ? threads.get(this.deps.db, entry.scope.thread.id) : null;
    // A team run is the coordinator's to replace: restarting here would spawn a process outside its reservation,
    // unshared and unbound, in the conversation's workspace. A busy run takes the message as steering; its settings
    // are read again at the next turn.
    // Ordinary retries also need a new run after failure, even when settings match.
    if (thread && (await this.shouldRestart(entry, thread))) {
      await this.restartTurn(entry, thread, text, options);
      return;
    }
    await this.sendExisting(entry, text, options);
  }

  private async shouldRestart(entry: LiveRun, thread: Thread | null): Promise<boolean> {
    if (!thread || entry.team || entry.busy) return false;
    if (this.mustRestart(entry, thread)) return true;
    return !(await this.applyThreadSettings(entry, thread));
  }

  private async restartTurn(entry: LiveRun, thread: Thread, text: string, options: SendOptions): Promise<void> {
    // A Workspace conversation works in its own folder, not the Workspace root.
    const project = executionProject(this.deps.db, thread);
    await this.deps.start({
      scope: { thread, task: null },
      project,
      agent: thread.agent,
      model: thread.model ?? entry.run.model ?? undefined,
      effort: thread.effort ?? undefined,
      fastMode: thread.fastMode,
      mode: thread.mode,
      permissionMode: thread.permissionMode,
      prompt: text,
      promptRole: options.role ?? "user",
      recordPrompt: options.recordPrompt ?? true,
      attachments: options.attachments,
      resume: true,
    });
  }

  private async sendExisting(entry: LiveRun, text: string, options: SendOptions): Promise<void> {
    const { role = "user", attachments, recordPrompt = true } = options;
    const runId = entry.run.id;
    const previous = { busy: entry.busy, prompt: entry.prompt, reply: entry.reply, turns: entry.turns, questionsInterrupted: entry.questionsInterrupted };
    this.deps.disarmIdle(runId);
    entry.busy = true;
    if (!previous.busy) entry.questionsInterrupted = false;
    if (role === "user") {
      entry.prompt = text;
      entry.reply = null;
    }
    this.deps.invalidate(this.deps.keysFor(entry.scope));
    try {
      await entry.handle.send(text, attachments);
    } catch (error) {
      this.restoreRejectedSend(entry, previous);
      throw error;
    }
    // The provider has the input. A caller that records the turn does so now, while the process is known to be busy.
    if (options.onAccepted) {
      try {
        options.onAccepted(entry.run, entry.turns);
      } catch (error) {
        entry.handle.close();
        throw error;
      }
    }
    if (recordPrompt) this.deps.emit({ type: "message.completed", runId, ts: Date.now(), messageId: `${role}-${randomUUID()}`, role, text, ...(attachments?.length ? { attachments } : {}) });
    if (entry.scope.thread) threads.touch(this.deps.db, entry.scope.thread.id);
    this.deps.invalidate(this.deps.keysFor(entry.scope));
  }

  private restoreRejectedSend(entry: LiveRun, previous: { busy: boolean; prompt: string | null; reply: string | null; turns: number; questionsInterrupted?: boolean }): void {
    // A rejected steer is not a delivered message or a new working turn.
    if (entry.turns === previous.turns) {
      entry.busy = previous.busy;
      entry.questionsInterrupted = previous.questionsInterrupted;
    }
    if (!entry.busy) this.deps.armIdle(entry);
    entry.prompt = previous.prompt;
    entry.reply = previous.reply;
    this.deps.invalidate(this.deps.keysFor(entry.scope));
  }

  private mustRestart(entry: LiveRun, thread: Thread): boolean {
    const launchPreference = entry.run.mode === "plan" ? entry.run.permissionMode : entry.providerPermissionMode;
    if (entry.failed !== null || thread.permissionMode !== launchPreference || thread.mode !== entry.run.mode || thread.agent !== entry.run.agent) return true;
    // A guest Orcling's process hands the thread back to its own speaker, and an Orcling's own conversation may be due a new session.
    return (entry.run.orclingId ?? null) !== (thread.orclingId ?? null) || this.deps.hooks.orclings?.rolloverDue(thread) === true;
  }

  private async applyThreadSettings(entry: LiveRun, thread: Thread): Promise<boolean> {
    const settings = this.requestedSettings(entry, thread);
    if (!settings) return false;
    if (settings.model === undefined && settings.effort === undefined && settings.fastMode === undefined) return true;
    if (settings.fastMode) await this.deps.validateFastMode(thread.agent, thread.model ?? entry.run.model ?? undefined, true);
    if (!entry.handle.canApplySettings) return false;
    try {
      await entry.handle.applySettings(settings);
    } catch (error) {
      this.deps.log.warn(`run ${entry.run.id} keeps its process settings; restarting instead: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    entry.run = { ...entry.run, model: settings.model ?? entry.run.model, effort: settings.effort ?? entry.run.effort, fastMode: settings.fastMode ?? entry.run.fastMode };
    runs.update(this.deps.db, entry.run.id, { model: entry.run.model, effort: entry.run.effort, fastMode: entry.run.fastMode });
    this.emitSettingsNotice(entry, settings);
    return true;
  }

  private requestedSettings(entry: LiveRun, thread: Thread): LiveSettings | null {
    const settings: LiveSettings = {};
    if (thread.model !== null && thread.model !== entry.run.model) settings.model = thread.model;
    if (thread.effort !== entry.run.effort) {
      if (thread.effort === null) return null;
      settings.effort = thread.effort;
    }
    if (thread.fastMode !== entry.run.fastMode) settings.fastMode = thread.fastMode;
    return settings;
  }

  private emitSettingsNotice(entry: LiveRun, settings: LiveSettings): void {
    let fast = "";
    if (settings.fastMode !== undefined) fast = settings.fastMode ? ", Fast on" : ", Fast off";
    this.deps.emit({
      type: "message.completed",
      runId: entry.run.id,
      ts: Date.now(),
      messageId: `settings-${randomUUID()}`,
      role: "system",
      text: `Switched to ${entry.run.model ?? "the default model"}${entry.run.effort ? ` at ${entry.run.effort} effort` : ""}${fast}.`,
    });
  }
}
