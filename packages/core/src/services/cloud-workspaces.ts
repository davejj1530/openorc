import path from "node:path";
import type { AgentHost } from "@openorc/agents";
import {
  installRunner,
  LocalSandboxProvider,
  pullWorkspace,
  pushWorkspace,
  RunnerClient,
  runnerFiles,
  seedFromCommit,
  seedWorkspace,
  VercelSandboxProvider,
  type RunnerFile,
  type Sandbox,
  type SandboxInfo,
  type SandboxProvider,
  type VercelConnection,
  type WorkspaceLocation,
} from "@openorc/cloud";
import { cloudWorkspaces, type CloudMirrorState, type CloudProviderId, type CloudWorkspaceRecord, type Db } from "@openorc/db";
import { originUrl } from "@openorc/git";
import { WORKSPACE_ID, type CloudStep, type CloudThreadState, type Project, type Thread } from "@openorc/protocol";
import type { Logger } from "../transport.js";
import { cloudAgentHost } from "./cloud-agent-host.js";
import { CloudAwake } from "./cloud-awake.js";
import type { CloudCheckTarget } from "./cloud-check.js";
import type { CloudSessions } from "./cloud-sessions.js";
import type { CloudAgentEnvironment } from "./cloud-agent-env.js";
import type { StartThreadInput } from "./thread-inputs.js";

export interface CloudWorkspaceOptions {
  /** Every sandbox service a workspace may have been made with. A workspace keeps using its own. */
  providers: SandboxProvider[];
  /** Where new cloud conversations run, decided as each is started. Defaults to the first provider. */
  forNewThreads?: () => Promise<SandboxProvider>;
  /** Node in the sandbox, which runs OpenOrc's runner. */
  node?: string;
  files?: RunnerFile[];
  /** How the thread's Claude account signs in to the sandbox. Without it, agents use the sandbox's own environment. */
  agentEnvironment?: CloudAgentEnvironment;
  /** A conversation's cloud state changed, for the window to refresh it. */
  changed?: (threadId: string) => void;
  /** Keeps each conversation's Claude session on both sides. */
  sessions?: CloudSessions;
}

const SETUP_OUTPUT_TAIL = 2000;
/** An idle agent keeps its VM awake, so in the cloud its process closes after this at the latest. */
export const CLOUD_IDLE_PROCESS_MS = 10 * 60_000;
/** A host made for a turn whose agent never starts lets its VM go after this. */
const LAUNCH_HOLD_MS = 60_000;
/** The adapters take a cloud host, but only Claude's has been tried in a sandbox. */
export const CLOUD_AGENTS = "Only Claude runs in cloud workspaces so far.";

/** A cloud conversation runs in a project, on a worktree of its own, with an agent that runs in a sandbox. */
export function assertCloudStart(input: Pick<StartThreadInput, "agent" | "checkout">, project: Project): void {
  if (input.checkout || project.id === WORKSPACE_ID) throw new Error("Cloud conversations start in a project, on a worktree of their own.");
  if (input.agent !== "claude") throw new Error(CLOUD_AGENTS);
}

/**
 * The sandbox services the app offers: Vercel once it is connected, sandboxes simulated on this Mac otherwise. A
 * provider passed in, as tests do, takes new conversations instead.
 */
export function cloudSandboxProviders(input: {
  dataDir: string;
  env: () => NodeJS.ProcessEnv;
  credentials?: () => Promise<VercelConnection | null>;
  override?: SandboxProvider;
}): Pick<CloudWorkspaceOptions, "providers" | "forNewThreads"> {
  const local = new LocalSandboxProvider(path.join(input.dataDir, "cloud-sandboxes"), input.env);
  const credentials = input.credentials ?? (async () => null);
  const vercel = new VercelSandboxProvider({ credentials });
  const { override } = input;
  const providers = override ? [override, ...[local, vercel].filter((provider) => provider.id !== override.id)] : [local, vercel];
  return { providers, forNewThreads: async () => override ?? ((await credentials()) ? vercel : local) };
}

/** Which sandbox is a conversation's, on which service: its cloud workspace's, or its standby's before it has one. */
export type SandboxRef = Pick<CloudWorkspaceRecord, "threadId" | "provider" | "sandbox">;

/** A sandbox a service reports, with where it runs and the conversation it belongs to, if any. */
export type ListedSandbox = SandboxInfo & { provider: CloudProviderId; threadId: string | null };

/** Where a cloud conversation's agent runs, its working folder there, and how its account signs in. */
export interface CloudRunHost {
  host: AgentHost;
  cwd: string;
  env: Record<string, string>;
}

export interface Connection {
  location: WorkspaceLocation;
  client: RunnerClient;
}

/**
 * Sandboxes for cloud conversations. A cloud conversation keeps an ordinary worktree on the Mac, which mirrors the
 * sandbox's checkout; this service opens the sandbox, gives it the worktree's code and runs the project's setup there.
 */
export class CloudWorkspaceService {
  private files: RunnerFile[] | null;
  /** Where each conversation's code lives, worked out once: opening the sandbox and installing the runner. */
  private readonly locations = new Map<string, Promise<WorkspaceLocation>>();
  /** One runner connection per conversation, kept while its VM is held awake. */
  private readonly connections = new Map<string, Promise<Connection>>();
  private readonly awake: CloudAwake;
  /** VMs being stopped because nothing needs them; the next use waits for the stop. */
  private readonly stopping = new Map<string, Promise<void>>();
  /** Conversations whose sandbox is finishing a turn it took over while this Mac slept. */
  private readonly takeovers = new Set<string>();
  /** A conversation's sandbox being prepared; asking again waits for it instead of preparing twice. */
  private readonly preparing = new Map<string, Promise<void>>();
  /** The sync running for each conversation; the next one waits for it. */
  private readonly syncs = new Map<string, Promise<boolean>>();
  /** Conversations seeded since their last turn: nothing has changed on either side, so their first turn starts without a sync. */
  private readonly pristine = new Set<string>();
  /** The preparing step each conversation is on. */
  private readonly progress = new Map<string, { step: CloudStep; setup: boolean }>();

  constructor(
    private readonly db: Db,
    private readonly options: CloudWorkspaceOptions,
    private readonly log: Logger,
  ) {
    this.files = options.files ?? null;
    this.awake = new CloudAwake({ released: (threadId) => this.sleep(threadId), log });
  }

  /** Checks a new cloud conversation and picks where it runs. Call before admitting it. */
  /** The provider a new cloud conversation runs on. Refused before anything is made when its account cannot sign in there. */
  async place(input: Pick<StartThreadInput, "agent" | "checkout" | "claudeAccountId">, project: Project): Promise<CloudProviderId> {
    assertCloudStart(input, project);
    const provider = await this.forNewThreads();
    await this.options.agentEnvironment?.(provider.id, input.claudeAccountId);
    return provider.id;
  }

  /** Where a new cloud conversation would run, and what its runner needs there, for the cloud check. */
  async checkTarget(): Promise<CloudCheckTarget> {
    this.files ??= runnerFiles();
    return { provider: await this.forNewThreads(), files: this.files, ...(this.options.node ? { node: this.options.node } : {}) };
  }

  private async forNewThreads(): Promise<SandboxProvider> {
    const provider = (await this.options.forNewThreads?.()) ?? this.options.providers[0];
    if (!provider) throw new Error("Cloud workspaces are not available.");
    return provider;
  }

  /** Recorded in the transaction that admits the conversation, before its worktree exists. */
  admit(threadId: string, provider: CloudProviderId): CloudWorkspaceRecord {
    return cloudWorkspaces.insert(this.db, { threadId, provider, sandbox: `openorc-${threadId}` });
  }

  private provider(id: CloudProviderId): SandboxProvider {
    const provider = this.options.providers.find((candidate) => candidate.id === id);
    if (!provider) throw new Error(`This conversation's cloud workspace runs on ${id}, which this app is not set up for.`);
    return provider;
  }

  get(threadId: string): CloudWorkspaceRecord | null {
    return cloudWorkspaces.get(this.db, threadId);
  }

  /** Where the conversation's code lives in its sandbox and on the Mac. Waits for a stop in progress, then wakes the VM. */
  async location(record: SandboxRef, mirror: string): Promise<WorkspaceLocation> {
    await this.stopping.get(record.threadId);
    const existing = this.locations.get(record.threadId);
    if (existing) return existing;
    const location = (async () => {
      const sandbox = await this.provider(record.provider).open(record.sandbox);
      this.files ??= runnerFiles();
      const install = await installRunner(sandbox, this.files, this.options.node);
      return { install, repo: path.posix.join(sandbox.root, "repo"), mirror, refPrefix: `refs/openorc/cloud/${record.threadId}/` };
    })();
    this.locations.set(record.threadId, location);
    location.catch(() => this.locations.delete(record.threadId));
    return location;
  }

  /**
   * Brings the sandbox's changes to the conversation's worktree on the Mac. With `push`, what changed in the worktree
   * first goes to the sandbox: between turns the Mac may commit, undo or edit, while during a turn only the sandbox
   * writes. Syncs for one conversation run one after another. False when the worktree did not change, or the
   * conversation does not run in the cloud.
   */
  sync(thread: Thread, options: { push?: boolean; turnEnded?: boolean } = {}): Promise<boolean> {
    const record = cloudWorkspaces.get(this.db, thread.id);
    const mirror = thread.worktreePath;
    if (record?.state !== "ready" || !mirror) return Promise.resolve(false);
    if (options.push && this.pristine.delete(thread.id)) return Promise.resolve(false);
    const previous = this.syncs.get(thread.id) ?? Promise.resolve(false);
    const next = previous
      .catch(() => false)
      .then(async () => {
        if (options.push) await this.pushOnce(thread.id, mirror);
        const changed = await this.pullOnce(thread.id, mirror);
        if (options.turnEnded) await this.keepSession(thread, mirror);
        return changed;
      });
    this.syncs.set(thread.id, next);
    void next
      .finally(() => {
        if (this.syncs.get(thread.id) === next) this.syncs.delete(thread.id);
      })
      .catch(() => undefined);
    return next;
  }

  private async pushOnce(threadId: string, mirror: string): Promise<void> {
    const record = cloudWorkspaces.get(this.db, threadId);
    if (record?.state !== "ready" || !record.mirror) return;
    const result = await pushWorkspace(await this.location(record, mirror), record.mirror);
    if (result.pushed) cloudWorkspaces.ready(this.db, threadId, result.state);
  }

  private async pullOnce(threadId: string, mirror: string): Promise<boolean> {
    // Read again: the sync before this one moved the state on.
    const record = cloudWorkspaces.get(this.db, threadId);
    if (record?.state !== "ready" || !record.mirror) return false;
    const result = await pullWorkspace(await this.location(record, mirror), record.mirror);
    if (result.state.snapshot !== record.mirror.snapshot) cloudWorkspaces.ready(this.db, threadId, result.state);
    if (result.keptLocalEdits) this.log.info(`thread ${threadId}: edits made on the Mac were kept in ${result.keptLocalEdits} before the cloud's files replaced them`);
    if (result.keptLocalCommit) this.log.info(`thread ${threadId}: a commit made on the Mac was kept in ${result.keptLocalCommit} when the branch followed the cloud`);
    return result.changed;
  }

  /**
   * Gives the sandbox the worktree's branch and uncommitted work, then runs the project's setup script there instead
   * of on the Mac. A workspace that is ready is left alone; one that failed is tried again.
   */
  async prepare(thread: Thread, project: Project): Promise<void> {
    const existing = this.preparing.get(thread.id);
    if (existing) return existing;
    const preparation = this.prepareOnce(thread, project).finally(() => this.preparing.delete(thread.id));
    this.preparing.set(thread.id, preparation);
    return preparation;
  }

  private async prepareOnce(thread: Thread, project: Project): Promise<void> {
    const record = cloudWorkspaces.get(this.db, thread.id);
    if (!record || record.state === "ready") return;
    const { worktreePath, branch } = thread;
    if (!worktreePath || !branch) throw new Error("A cloud conversation needs its worktree before its sandbox.");
    // The conversation may have run on this Mac, or in a sandbox since replaced: its session goes up with the code.
    const seed = async (location: WorkspaceLocation, origin: string | undefined) => {
      const state = await seedWorkspace(location, branch, origin);
      await this.options.sessions?.send(thread, location, record.provider);
      return state;
    };
    this.ready(thread.id, await this.build(thread.id, project, worktreePath, seed));
  }

  /** Brings the conversation's Claude session to this Mac. A session not kept now is kept after the next turn. */
  private async keepSession(thread: Thread, mirror: string): Promise<void> {
    const record = cloudWorkspaces.get(this.db, thread.id);
    if (!record || !this.options.sessions) return;
    await this.options.sessions.keep(thread, await this.location(record, mirror), record.provider).catch((error: unknown) => {
      this.log.warn(`could not bring thread ${thread.id}'s Claude session to the Mac: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /**
   * Seeds a new conversation's sandbox from the commit its worktree starts at and runs the project's setup there, while
   * the worktree is made. The workspace becomes ready with `ready` once the worktree exists too.
   */
  seedFresh(threadId: string, project: Project, start: { mirror: string; branch: string; commit: string }): Promise<CloudMirrorState> {
    const { commit, branch } = start;
    return this.build(threadId, project, start.mirror, (location, origin) => seedFromCommit(location, { source: project.rootPath, commit, branch, ...(origin ? { origin } : {}) }));
  }

  /** Opens the sandbox, gives it the code with `seed` and runs the project's setup there, reporting each step as it starts. */
  private async build(threadId: string, project: Project, mirror: string, seed: (location: WorkspaceLocation, origin: string | undefined) => Promise<CloudMirrorState>): Promise<CloudMirrorState> {
    const record = cloudWorkspaces.get(this.db, threadId);
    if (!record) throw new Error(`Thread ${threadId} has no cloud workspace.`);
    const script = project.settings.setupScript;
    cloudWorkspaces.preparing(this.db, threadId);
    let release: () => void = () => undefined;
    try {
      this.step(threadId, { step: "sandbox", setup: Boolean(script) });
      const location = await this.location(record, mirror);
      release = this.awake.hold(threadId, location.install.sandbox);
      this.step(threadId, { step: "code", setup: Boolean(script) });
      const state = await seed(location, (await originUrl(project.rootPath)) ?? undefined);
      if (script) {
        this.step(threadId, { step: "setup", setup: true });
        await this.runSetup(location, script, path.basename(mirror));
      }
      return state;
    } catch (error) {
      cloudWorkspaces.failed(this.db, threadId, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      release();
      this.step(threadId, null);
    }
  }

  private step(threadId: string, progress: { step: CloudStep; setup: boolean } | null): void {
    if (progress) this.progress.set(threadId, progress);
    else this.progress.delete(threadId);
    this.options.changed?.(threadId);
  }

  /** What a cloud thread's summary shows; null for a thread that runs on this Mac. */
  state(threadId: string): CloudThreadState | null {
    const record = cloudWorkspaces.get(this.db, threadId);
    if (!record) return null;
    const progress = this.progress.get(threadId);
    return { provider: record.provider, state: record.state, step: progress?.step ?? null, setup: progress?.setup ?? false, error: record.error };
  }

  /** The sandbox has the code and the worktree on the Mac holds `mirror`. */
  ready(threadId: string, mirror: CloudMirrorState): void {
    cloudWorkspaces.ready(this.db, threadId, mirror);
    this.pristine.add(threadId);
    this.options.changed?.(threadId);
    this.log.info(`cloud workspace for thread ${threadId} is ready`);
  }

  /**
   * Where the conversation's next turn runs, or null when it runs on this Mac. MCP requests from the sandbox reach
   * `mcpOrigin` on the Mac through the runner.
   */
  async host(thread: Thread, mcpOrigin: string, claudeAccountId?: string | null): Promise<CloudRunHost | null> {
    const record = cloudWorkspaces.get(this.db, thread.id);
    if (!record) return null;
    if (record.state !== "ready" || !thread.worktreePath) throw new Error("This conversation's cloud workspace is not ready. Send again to set it up.");
    if (this.takeovers.has(thread.id)) throw new Error("Claude is still finishing the turn it carried on in the cloud while this Mac slept. Send again once it is done.");
    // Each turn signs in as the account it runs on, so changing the thread's account takes effect at the next turn.
    const env = (await this.options.agentEnvironment?.(record.provider, claudeAccountId)) ?? {};
    const { sandbox } = (await this.location(record, thread.worktreePath)).install;
    // The VM stays awake from here until the agent's process has started, then for as long as each process runs.
    const launching = this.awake.hold(thread.id, sandbox);
    const unused = setTimeout(launching, LAUNCH_HOLD_MS);
    unused.unref();
    try {
      const { location, client } = await this.connect(record, thread.worktreePath);
      const port = await client.relay("mcp", mcpOrigin);
      const host = cloudAgentHost(client, location, port, (proc) => {
        proc.once("close", this.awake.hold(thread.id, sandbox));
        clearTimeout(unused);
        launching();
      });
      return { host, cwd: location.repo, env };
    } catch (error) {
      clearTimeout(unused);
      launching();
      throw error;
    }
  }

  /**
   * Deletes a conversation's sandbox for good, with its files. The worktree on the Mac keeps what was synced. Nothing
   * for a conversation on this Mac.
   */
  async remove(threadId: string): Promise<void> {
    const record = cloudWorkspaces.get(this.db, threadId);
    if (record) await this.deleteSandbox(record);
  }

  /** OpenOrc's sandboxes on every service set up now, with the conversation each belongs to. */
  async sandboxes(): Promise<ListedSandbox[]> {
    const listed = await Promise.all(
      this.options.providers.map(async (provider) => {
        const owners = new Map(cloudWorkspaces.listByProvider(this.db, provider.id).map((record) => [record.sandbox, record.threadId]));
        return (await provider.list()).map((info) => ({ ...info, provider: provider.id, threadId: owners.get(info.name) ?? null }));
      }),
    );
    return listed.flat();
  }

  /**
   * Deletes one sandbox for good. A conversation's worktree keeps what was synced, and its next turn sets up a new
   * sandbox from there. Stop the conversation's agent first: deleting the VM would end it mid-turn.
   */
  async removeSandbox(providerId: CloudProviderId, name: string): Promise<void> {
    const record = cloudWorkspaces.listByProvider(this.db, providerId).find((candidate) => candidate.sandbox === name);
    if (!record) {
      await this.provider(providerId).remove(name);
      this.log.info(`deleted sandbox ${name}, which no conversation had`);
      return;
    }
    await this.deleteSandbox(record);
    cloudWorkspaces.removed(this.db, record.threadId);
    this.options.changed?.(record.threadId);
  }

  private async deleteSandbox(record: CloudWorkspaceRecord): Promise<void> {
    this.disconnect(record.threadId);
    this.locations.delete(record.threadId);
    this.pristine.delete(record.threadId);
    await this.provider(record.provider).remove(record.sandbox);
    this.log.info(`deleted cloud workspace ${record.sandbox}`);
  }

  /** Marks a conversation whose sandbox is finishing a turn it took over; a new turn waits until it has. */
  takingOver(threadId: string, running: boolean): void {
    if (running) this.takeovers.add(threadId);
    else this.takeovers.delete(threadId);
    this.options.changed?.(threadId);
  }

  /** Keeps the conversation's VM awake until the returned function is called. */
  holdAwake(threadId: string, sandbox: Sandbox): () => void {
    return this.awake.hold(threadId, sandbox);
  }

  /** This Mac is going away: every VM in use keeps going on its own for `forMs`, so a turn in flight can finish. */
  away(forMs: number): Promise<void> {
    return this.awake.extendAll(forMs);
  }

  /**
   * A conversation whose standby sandbox took over becomes a cloud conversation, its worktree on this Mac matching
   * `mirror` in that sandbox. Its next sync brings what the sandbox did since.
   */
  adopt(ref: SandboxRef, mirror: CloudMirrorState): void {
    cloudWorkspaces.insert(this.db, { threadId: ref.threadId, provider: ref.provider, sandbox: ref.sandbox });
    cloudWorkspaces.ready(this.db, ref.threadId, mirror);
    this.options.changed?.(ref.threadId);
  }

  /** Disconnects from every sandbox. Processes in a cloud VM keep running there; sandboxes on this Mac stop. */
  async close(): Promise<void> {
    this.awake.close();
    const connections = [...this.connections.values()];
    this.connections.clear();
    for (const connection of await Promise.allSettled(connections)) if (connection.status === "fulfilled") connection.value.client.close();
    await Promise.all(this.options.providers.map((provider) => provider.close?.()));
  }

  /**
   * Nothing needs the conversation's VM: its runner connection goes, since reconnecting would wake it, and the VM stops
   * with its files kept. The next turn starts it again.
   */
  private sleep(threadId: string): void {
    this.disconnect(threadId);
    const location = this.locations.get(threadId);
    if (!location || this.stopping.has(threadId)) return;
    const stop = location
      .then(({ install }) => install.sandbox.stop())
      .then(() => this.log.info(`cloud workspace of thread ${threadId} stopped; nothing runs there`))
      .catch((error: unknown) => this.log.warn(`cloud workspace of thread ${threadId} did not stop, so it stops on its own later: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => this.stopping.delete(threadId));
    this.stopping.set(threadId, stop);
  }

  private disconnect(threadId: string): void {
    const connection = this.connections.get(threadId);
    if (!connection) return;
    this.connections.delete(threadId);
    void connection.then(({ client }) => client.close()).catch(() => undefined);
  }

  /** The conversation's runner connection, made once and kept while its VM is held awake. */
  connect(record: SandboxRef, mirror: string): Promise<Connection> {
    const existing = this.connections.get(record.threadId);
    if (existing) return existing;
    const connection = (async () => {
      const location = await this.location(record, mirror);
      const client = await RunnerClient.open(location.install, (state) => this.log.info(`cloud workspace ${record.sandbox} ${state}`));
      return { location, client };
    })();
    this.connections.set(record.threadId, connection);
    connection.catch(() => this.connections.delete(record.threadId));
    return connection;
  }

  private async runSetup(location: WorkspaceLocation, script: string, name: string): Promise<void> {
    const { repo } = location;
    const env = { OPENORC_WORKSPACE_PATH: repo, OPENORC_ROOT_PATH: repo, OPENORC_WORKSPACE_NAME: name, OPENORC_CLOUD: "1" };
    const result = await location.install.sandbox.exec("bash", ["-lc", script], { cwd: repo, env });
    if (result.code === 0) return;
    const output = `${result.stdout.toString("utf8")}${result.stderr}`.trim().slice(-SETUP_OUTPUT_TAIL);
    throw new Error(`The setup script failed in the cloud workspace (exit ${result.code ?? "signal"}).${output ? `\n${output}` : ""}`);
  }
}
