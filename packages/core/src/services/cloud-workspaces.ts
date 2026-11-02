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
  type SandboxProvider,
  type VercelAccess,
  type WorkspaceLocation,
} from "@openorc/cloud";
import { cloudWorkspaces, type CloudMirrorState, type CloudProviderId, type CloudWorkspaceRecord, type Db } from "@openorc/db";
import { originUrl } from "@openorc/git";
import { WORKSPACE_ID, type Project, type Thread } from "@openorc/protocol";
import type { Logger } from "../transport.js";
import { cloudAgentHost } from "./cloud-agent-host.js";
import type { StartThreadInput } from "./thread-inputs.js";

export interface CloudWorkspaceOptions {
  /** Every sandbox service a workspace may have been made with. A workspace keeps using its own. */
  providers: SandboxProvider[];
  /** Where new cloud conversations run, decided as each is started. Defaults to the first provider. */
  forNewThreads?: () => Promise<SandboxProvider>;
  /** Node in the sandbox, which runs OpenOrc's runner. */
  node?: string;
  files?: RunnerFile[];
}

const SETUP_OUTPUT_TAIL = 2000;
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
  credentials?: () => Promise<VercelAccess | null>;
  override?: SandboxProvider;
}): Pick<CloudWorkspaceOptions, "providers" | "forNewThreads"> {
  const local = new LocalSandboxProvider(path.join(input.dataDir, "cloud-sandboxes"), input.env);
  const credentials = input.credentials ?? (async () => null);
  const vercel = new VercelSandboxProvider({ credentials });
  const { override } = input;
  const providers = override ? [override, ...[local, vercel].filter((provider) => provider.id !== override.id)] : [local, vercel];
  return { providers, forNewThreads: async () => override ?? ((await credentials()) ? vercel : local) };
}

/** Where a cloud conversation's agent runs, and its working folder there. */
export interface CloudRunHost {
  host: AgentHost;
  cwd: string;
}

interface Connection {
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
  /** One runner connection per conversation, kept for the life of the core. */
  private readonly connections = new Map<string, Promise<Connection>>();
  /** The sync running for each conversation; the next one waits for it. */
  private readonly syncs = new Map<string, Promise<boolean>>();
  /** Conversations seeded since their last turn: nothing has changed on either side, so their first turn starts without a sync. */
  private readonly pristine = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly options: CloudWorkspaceOptions,
    private readonly log: Logger,
  ) {
    this.files = options.files ?? null;
  }

  /** Checks a new cloud conversation and picks where it runs. Call before admitting it. */
  async place(input: Pick<StartThreadInput, "agent" | "checkout">, project: Project): Promise<CloudProviderId> {
    assertCloudStart(input, project);
    const provider = (await this.options.forNewThreads?.()) ?? this.options.providers[0];
    if (!provider) throw new Error("Cloud workspaces are not available.");
    return provider.id;
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

  /** Where the conversation's code lives in its sandbox and on the Mac. */
  location(record: CloudWorkspaceRecord, mirror: string): Promise<WorkspaceLocation> {
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
  sync(thread: Thread, options: { push?: boolean } = {}): Promise<boolean> {
    const record = cloudWorkspaces.get(this.db, thread.id);
    const mirror = thread.worktreePath;
    if (record?.state !== "ready" || !mirror) return Promise.resolve(false);
    if (options.push && this.pristine.delete(thread.id)) return Promise.resolve(false);
    const previous = this.syncs.get(thread.id) ?? Promise.resolve(false);
    const next = previous
      .catch(() => false)
      .then(async () => {
        if (options.push) await this.pushOnce(thread.id, mirror);
        return this.pullOnce(thread.id, mirror);
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
    const record = cloudWorkspaces.get(this.db, thread.id);
    if (!record || record.state === "ready") return;
    if (!thread.worktreePath || !thread.branch) throw new Error("A cloud conversation needs its worktree before its sandbox.");
    try {
      const location = await this.location(record, thread.worktreePath);
      const mirror = await seedWorkspace(location, thread.branch, (await originUrl(project.rootPath)) ?? undefined);
      if (project.settings.setupScript) await this.runSetup(location, project.settings.setupScript, path.basename(thread.worktreePath));
      this.ready(thread.id, mirror);
    } catch (error) {
      cloudWorkspaces.failed(this.db, thread.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /**
   * Seeds a new conversation's sandbox from the commit its worktree starts at and runs the project's setup there, while
   * the worktree is made. The workspace becomes ready with `ready` once the worktree exists too.
   */
  async seedFresh(threadId: string, project: Project, start: { mirror: string; branch: string; commit: string }): Promise<CloudMirrorState> {
    const record = cloudWorkspaces.get(this.db, threadId);
    if (!record) throw new Error(`Thread ${threadId} has no cloud workspace.`);
    try {
      const location = await this.location(record, start.mirror);
      const origin = (await originUrl(project.rootPath)) ?? undefined;
      const mirror = await seedFromCommit(location, { source: project.rootPath, commit: start.commit, branch: start.branch, ...(origin ? { origin } : {}) });
      if (project.settings.setupScript) await this.runSetup(location, project.settings.setupScript, path.basename(start.mirror));
      return mirror;
    } catch (error) {
      cloudWorkspaces.failed(this.db, threadId, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /** The sandbox has the code and the worktree on the Mac holds `mirror`. */
  ready(threadId: string, mirror: CloudMirrorState): void {
    cloudWorkspaces.ready(this.db, threadId, mirror);
    this.pristine.add(threadId);
    this.log.info(`cloud workspace for thread ${threadId} is ready`);
  }

  /**
   * Where the conversation's next turn runs, or null when it runs on this Mac. MCP requests from the sandbox reach
   * `mcpOrigin` on the Mac through the runner.
   */
  async host(thread: Thread, mcpOrigin: string): Promise<CloudRunHost | null> {
    const record = cloudWorkspaces.get(this.db, thread.id);
    if (!record) return null;
    if (record.state !== "ready" || !thread.worktreePath) throw new Error("This conversation's cloud workspace is not ready. Send again to set it up.");
    const { location, client } = await this.connect(record, thread.worktreePath);
    const port = await client.relay("mcp", mcpOrigin);
    return { host: cloudAgentHost(client, location, port), cwd: location.repo };
  }

  /** Disconnects from every sandbox. Processes in a cloud VM keep running there; sandboxes on this Mac stop. */
  async close(): Promise<void> {
    const connections = [...this.connections.values()];
    this.connections.clear();
    for (const connection of await Promise.allSettled(connections)) if (connection.status === "fulfilled") connection.value.client.close();
    await Promise.all(this.options.providers.map((provider) => provider.close?.()));
  }

  private connect(record: CloudWorkspaceRecord, mirror: string): Promise<Connection> {
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
