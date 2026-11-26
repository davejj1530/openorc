import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { projects, triggerThread, type Db, type WatchedAutomation } from "@openorc/db";
import { TriggerManifest, WORKSPACE_ID, type Project, type ThreadChoice, type TriggerState } from "@openorc/protocol";
import { z } from "zod";
import type { Logger } from "../transport.js";
import { AppSettingsService } from "./settings.js";
import type { ThreadService } from "./threads.js";
import type { TriggerValues } from "./trigger-values.js";

/** One thing a program printed, as an automation acts on it: told from the others by its key. */
export type ProgramEvent = { key: string; title: string; detail: string };

type Dependencies = {
  dataDir: string;
  values: TriggerValues;
  threads: Pick<ThreadService, "start">;
  /** An event for an automation switched on, to act on once. */
  fire: (automationId: string, event: ProgramEvent) => void;
  /** Why an automation's program is not running, or null once it is, for its row. */
  report: (automationId: string, problem: string | null) => void;
  invalidate: (keys: string[]) => void;
  log: Logger;
};

const Event = z.object({
  id: z.union([z.string(), z.number()]).transform(String).pipe(z.string().min(1).max(500)),
  title: z.string().trim().min(1).max(200),
  detail: z.string().max(8000).optional(),
});

/** How long a try runs before it stops by itself. */
const TRY_FOR = 5 * 60_000;
/** How long a program waits before it is started again after it stopped, by how many times in a row it has. */
const RESTARTS = [5_000, 30_000, 120_000, 600_000];
/** A program that ran this long has settled, so its next stop starts the waits over. */
const SETTLED = 10 * 60_000;
const RECENT = 40;

type Watch = {
  child: ChildProcess | null;
  /** The automation it runs for, or null while it is tried. */
  automationId: string | null;
  state: TriggerState["state"];
  problem: string | null;
  stops: number;
  startedAt: number;
  timer: NodeJS.Timeout | null;
};

/** How a running program runs: for its automation, or tried. */
const runningState = (watch: { automationId: string | null }): TriggerState["state"] => (watch.automationId ? "listening" : "trying");
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const listed = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? ""));

/** The brief its agent is given: what to watch, the one rule of what a program prints, and where its values come from. */
function brief(what: string, project: Project | null): string {
  const repository = project?.gitRemote ? ` It is for the project ${project.name}, whose git remote is ${project.gitRemote}.` : "";
  return [
    `Write a trigger program, in this folder, for an OpenOrc automation. It should notice: ${what}.${repository}`,
    "OpenOrc runs it on this Mac for as long as the automation is switched on, starting it with your command in this folder and starting it again if it stops.",
    'Each time the thing happens, print one line of JSON to standard output, and flush it: {"id": string, "title": string, "detail": string}. The id tells one event from another and is the same if the same event is printed again. The title is a few words a person reads. The detail is what an agent acting on it should know. Print nothing else to standard output; write anything else to standard error.',
    "When it starts, don't print what already happened: only what happens from then on.",
    "Watch however the source needs: a live connection, a mode that needs no public web address, watching files, or checking on a timer when that is all the source allows. Install what it needs inside this folder.",
    "Read any token or setting the person must give it from an environment variable, never from a file, and list each one in trigger.json. The person adds their values in OpenOrc.",
    'Write trigger.json: {"run": "the command that starts it", "env": [{"name": "SLACK_APP_TOKEN", "about": "Where the person gets it, in one sentence."}]}.',
    "Test what you can without the person's values. Then tell them, in a few sentences, what it watches and which values to add.",
  ].join("\n\n");
}

/**
 * Trigger programs: each in a folder of its own, written by an agent in a thread working there and changed by the
 * person as they like. One runs for its automation while that is switched on, with the values the person added in its
 * environment, and each line of JSON it prints is an event the automation acts on once. A program can also be tried,
 * which shows what it prints and acts on none of it.
 */
export class TriggerPrograms {
  private readonly watches = new Map<string, Watch>();
  /** What each printed lately, kept after it stops so a try's output stays to read. */
  private readonly printedLately = new Map<string, TriggerState["recent"]>();
  private closing = false;

  constructor(
    private readonly db: Db,
    private readonly deps: Dependencies,
  ) {}

  folder(id: string): string {
    return join(this.deps.dataDir, "triggers", id);
  }

  /** A thread where its agent writes the program, told what to watch for: in a new folder, or in its own to write it again. */
  async write({ id = randomUUID(), projectId, what, choice }: { id?: string | undefined; projectId: string; what: string; choice: ThreadChoice }): Promise<{ id: string; threadId: string }> {
    const folder = this.folder(id);
    await mkdir(folder, { recursive: true });
    const settings = new AppSettingsService(this.db).get();
    const { thread } = await this.deps.threads.start({
      projectId: WORKSPACE_ID,
      workingDirectory: folder,
      agent: choice.agent,
      model: choice.model,
      effort: choice.effort ?? undefined,
      ...(choice.claudeAccountId ? { claudeAccountId: choice.claudeAccountId } : {}),
      mode: "act",
      permissionMode: settings.defaultPermissionMode,
      workspaceMode: "current",
      prompt: brief(what, projects.get(this.db, projectId)),
      attachments: undefined,
      title: `Trigger: ${what}`.slice(0, 120),
    });
    return { id, threadId: thread.id };
  }

  async state(id: string): Promise<TriggerState> {
    const manifest = await this.manifest(id).catch(() => null);
    const values = await this.deps.values.of(id).catch((): Record<string, string> => ({}));
    const watch = this.watches.get(id);
    // A thread keeps its folder as the system resolves it, as /private/tmp for /tmp.
    const folder = await realpath(this.folder(id)).catch(() => this.folder(id));
    return {
      id,
      run: manifest?.run ?? null,
      env: (manifest?.env ?? []).map(({ name, about }) => ({ name, about, added: Boolean(values[name]) })),
      threadId: triggerThread(this.db, folder)?.id ?? null,
      state: watch?.state ?? "off",
      problem: watch?.problem ?? null,
      recent: this.printedLately.get(id) ?? [],
    };
  }

  /** Sets one of its values, and starts again a program that was waiting for it. */
  async setValue(id: string, name: string, value: string, watching: readonly WatchedAutomation[]): Promise<void> {
    await this.deps.values.set(id, name, value);
    this.deps.invalidate([`trigger:${id}`]);
    const watch = this.watches.get(id);
    if (watch?.state === "stopped") this.end(id);
    this.sync(watching);
  }

  /** Runs it to see what it prints, acting on none of it; one already running for its automation is left as it is. */
  async try(id: string, on: boolean): Promise<void> {
    const watch = this.watches.get(id);
    if (watch?.automationId) return;
    if (!on) return this.end(id);
    await this.launch(id, null);
    const tried = this.watches.get(id);
    if (tried?.child) tried.timer = setTimeout(() => this.end(id), TRY_FOR);
  }

  /**
   * Runs the programs of the automations switched on, and only those. One waiting for its program to be written or for
   * a value is looked at again; one that stopped by itself waits for its own restart.
   */
  sync(watching: readonly WatchedAutomation[]): void {
    if (this.closing) return;
    const wanted = new Map(watching.flatMap((automation) => (automation.trigger.kind === "program" ? [[automation.trigger.id, automation.id] as const] : [])));
    for (const [id, watch] of this.watches) if (watch.automationId && wanted.get(id) !== watch.automationId) this.end(id);
    for (const [id, automationId] of wanted) {
      const watch = this.watches.get(id);
      const waiting = watch?.state === "stopped" && !watch.child && !watch.timer;
      if (watch?.automationId === automationId && !waiting) continue;
      if (watch) this.end(id);
      void this.launch(id, automationId);
    }
  }

  stop(): void {
    this.closing = true;
    for (const id of [...this.watches.keys()]) this.end(id);
  }

  private async manifest(id: string): Promise<TriggerManifest> {
    const text = await readFile(join(this.folder(id), "trigger.json"), "utf8");
    return TriggerManifest.parse(JSON.parse(text));
  }

  private async launch(id: string, automationId: string | null): Promise<void> {
    const watch: Watch = { child: null, automationId, state: runningState({ automationId }), problem: null, stops: 0, startedAt: Date.now(), timer: null };
    this.watches.set(id, watch);
    const ready = await this.ready(id).catch((error: unknown) => ({ problem: `Its trigger.json can't be read: ${errorText(error)}` }));
    if (this.watches.get(id) !== watch) return;
    if ("problem" in ready) return this.changed(id, watch, ready.problem);
    this.start(id, watch, ready);
  }

  /** What it takes to start it: its command and every value it names, or why it can't start. */
  private async ready(id: string): Promise<{ run: string; env: Record<string, string> } | { problem: string }> {
    const manifest = await this.manifest(id).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!manifest) return { problem: "Its program isn't written yet." };
    const values = await this.deps.values.of(id);
    const missing = manifest.env.filter(({ name }) => !values[name]).map(({ name }) => name);
    if (missing.length > 0) return { problem: `Add ${listed(missing)} to start it.` };
    return { run: manifest.run, env: Object.fromEntries(manifest.env.map(({ name }) => [name, values[name]!])) };
  }

  private start(id: string, watch: Watch, ready: { run: string; env: Record<string, string> }): void {
    // A login shell, as the person's terminal has, so the program finds the tools they installed. Its own process group, so it stops with everything it started.
    const child = spawn("/bin/bash", ["-lc", ready.run], { cwd: this.folder(id), env: { ...process.env, ...ready.env, OPENORC_TRIGGER: id }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    watch.child = child;
    watch.startedAt = Date.now();
    this.changed(id, watch, null);
    createInterface({ input: child.stdout }).on("line", (line) => this.printed(id, watch, line));
    let said: string | null = null;
    createInterface({ input: child.stderr }).on("line", (line) => {
      if (!line.trim()) return;
      said = line.trim().slice(0, 500);
      this.note(id, said, false);
    });
    child.on("error", (error) => this.changed(id, watch, `It didn't start: ${error.message}`));
    child.on("exit", (code, signal) => {
      if (watch.child !== child) return;
      watch.child = null;
      if (this.watches.get(id) !== watch) return;
      const why = said ?? (signal ? `It was stopped by ${signal}.` : `It exited with code ${code ?? 0}.`);
      this.changed(id, watch, `It stopped. ${why}`);
      this.deps.log.warn(`trigger ${id} stopped: ${why}`);
      if (watch.automationId && !this.closing) this.restartLater(id, watch);
    });
  }

  private printed(id: string, watch: Watch, line: string): void {
    if (!line.trim()) return;
    const event = this.eventOf(line);
    this.note(id, event?.title ?? line.trim().slice(0, 500), Boolean(event));
    if (event && watch.automationId) this.deps.fire(watch.automationId, { key: `program:${event.id}`, title: event.title, detail: event.detail ?? event.title });
  }

  private eventOf(line: string): z.infer<typeof Event> | null {
    try {
      const parsed = Event.safeParse(JSON.parse(line));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private note(id: string, text: string, event: boolean): void {
    this.printedLately.set(id, [...(this.printedLately.get(id) ?? []), { at: Date.now(), text, event }].slice(-RECENT));
    this.deps.invalidate([`trigger:${id}`]);
  }

  private restartLater(id: string, watch: Watch): void {
    watch.stops = Date.now() - watch.startedAt > SETTLED ? 1 : watch.stops + 1;
    const wait = RESTARTS[Math.min(watch.stops, RESTARTS.length) - 1]!;
    watch.timer = setTimeout(() => {
      if (this.watches.get(id) !== watch || this.closing) return;
      void this.ready(id)
        .catch((error: unknown) => ({ problem: `Its trigger.json can't be read: ${errorText(error)}` }))
        .then((ready) => {
          if (this.watches.get(id) !== watch) return;
          if ("problem" in ready) this.changed(id, watch, ready.problem);
          else this.start(id, watch, ready);
        });
    }, wait);
  }

  /** Whether it runs, or why not, on its automation's row too. */
  private changed(id: string, watch: Watch, problem: string | null): void {
    watch.problem = problem;
    watch.state = problem ? "stopped" : runningState(watch);
    if (watch.automationId) this.deps.report(watch.automationId, problem);
    this.deps.invalidate([`trigger:${id}`]);
  }

  /** Stops it and forgets it. */
  private end(id: string): void {
    const watch = this.watches.get(id);
    if (!watch) return;
    this.watches.delete(id);
    if (watch.timer) clearTimeout(watch.timer);
    const child = watch.child;
    watch.child = null;
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // It had already ended.
      }
      setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          // It ended on SIGTERM.
        }
      }, 3_000).unref();
    }
    this.deps.invalidate([`trigger:${id}`]);
  }
}
