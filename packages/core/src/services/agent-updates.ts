import {
  harnessCatalog,
  harnessFailsToStart,
  harnessIds,
  harnessInfo,
  type AgentUpdate,
  type AgentUpdates,
  type HarnessId,
  type HarnessInfo,
  type RpcParams,
  type SystemInfo,
} from "@openorc/protocol";
import { type AgentInstallation, detectAgentInstallation, fetchAgentRelease, newerRelease, releaseVersion, runUpdateCommand, type UpdateRunner } from "./agent-update-installation.js";
import type { EnvSnapshot } from "./shell-environment.js";

interface Dependencies {
  info(refresh: boolean): Promise<SystemInfo>;
  environment(): EnvSnapshot;
  /** Atomically fences new work and closes only idle sessions; release reopens admission. */
  reserve(): Promise<() => void>;
  changed(): void;
  refreshed?(): void;
  read(key: string): string | null;
  write(key: string, value: string): void;
  detect?: typeof detectAgentInstallation;
  latest?: typeof fetchAgentRelease;
  run?: UpdateRunner;
}
const INTERVAL = 6 * 60 * 60 * 1000;
const key = (name: string) => `agentUpdates.${name}`;
const blank = (id: HarnessId): AgentUpdate => ({ id, installedVersion: null, latestVersion: null, status: "unchecked", method: "", canUpdate: false, message: null, checkedAt: null });
const actionable = new Set<AgentUpdate["status"]>(["available", "broken"]);

/** An installation that fails to start; OpenOrc offers the reinstall only when it knows the installer. */
function broken(plan: AgentInstallation, message: string | null): Pick<AgentUpdate, "status" | "installedVersion" | "method" | "canUpdate" | "message"> {
  const row = { status: "broken", installedVersion: null, method: plan.method } as const;
  if (!plan.repair) return { ...row, canUpdate: false, message: "Reinstall using the tool that installed this agent, then check again." };
  return { ...row, canUpdate: true, message };
}

/** A successful exit proves nothing; only the agent's own version probe afterwards does. */
function outcome(row: AgentUpdate, plan: AgentInstallation, after: HarnessInfo): Partial<AgentUpdate> {
  if (row.status === "broken") {
    if (harnessFailsToStart(after)) return { status: "error", message: "Reinstalling did not fix it. Check the installation in a terminal, then check again." };
    return { status: "unchecked", installedVersion: releaseVersion(after.version), canUpdate: false, message: "Reinstalled." };
  }
  if (harnessFailsToStart(after)) return broken(plan, `${harnessCatalog[row.id].name} no longer starts after the update.`);
  const installed = releaseVersion(after.version);
  if (!installed || newerRelease(row.latestVersion!, installed))
    return {
      status: "error",
      message: "The newer version is not active yet. Your package manager or release channel may be holding it back. Check the installation in a terminal, then check again.",
    };
  return { status: "current", installedVersion: installed, message: "Updated. Your next message uses the new version." };
}

/** Owns update state independently of windows. Only install() executes an updater. */
export class AgentUpdateService {
  private rows = harnessIds.map(blank);
  private checking: Promise<AgentUpdates> | null = null;
  private installing: Promise<AgentUpdates> | null = null;
  private plans = new Map<HarnessId, AgentInstallation>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  constructor(private readonly deps: Dependencies) {}

  get(): AgentUpdates {
    return {
      agents: this.rows.map((row) => ({ ...row })),
      checking: Boolean(this.checking),
      updating: Boolean(this.installing),
      automatic: this.deps.read(key("automatic")) !== "false",
      dismissed: this.deps.read(key("dismissed")),
    };
  }
  configure(patch: RpcParams<"agents.updates.configure">): AgentUpdates {
    if (patch.automatic !== undefined) this.deps.write(key("automatic"), String(patch.automatic));
    if (patch.dismissed !== undefined) this.deps.write(key("dismissed"), patch.dismissed);
    this.deps.changed();
    return this.get();
  }
  start(): void {
    if (this.timer || this.stopped) return;
    const tick = () => {
      if (this.stopped) return;
      if (this.get().automatic) void this.check().catch(() => undefined);
      this.timer = setTimeout(tick, INTERVAL);
      this.timer.unref();
    };
    this.timer = setTimeout(tick, 30_000);
    this.timer.unref();
  }
  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await Promise.allSettled([this.checking, this.installing]);
  }
  check(): Promise<AgentUpdates> {
    if (this.stopped) return Promise.resolve(this.get());
    if (this.installing) return this.installing;
    if (this.checking) return this.checking;
    // Reserve before yielding so concurrent windows share one check.
    this.checking = Promise.resolve()
      .then(() => this.scan())
      .finally(() => {
        this.checking = null;
        this.deps.changed();
      })
      .then(() => this.get());
    this.deps.changed();
    return this.checking;
  }
  private async scan(): Promise<void> {
    this.rows = this.rows.map((row) => ({ ...row, status: "checking", message: null }));
    this.deps.changed();
    let info: SystemInfo;
    try {
      info = await this.deps.info(true);
    } catch {
      this.rows = this.rows.map((row) => ({ ...row, status: "error", message: "Could not inspect installed agents. Check again." }));
      return;
    }
    const environment = this.deps.environment();
    await Promise.all(
      info.harnesses.map(async (harness) => {
        let row = blank(harness.id);
        try {
          if (!harness.path) row.status = "not_installed";
          else {
            row.installedVersion = releaseVersion(harness.version);
            const failing = harnessFailsToStart(harness);
            if (!row.installedVersion && !failing) throw new Error("The installed version could not be read. Check the agent in a terminal, then try again.");
            const plan = await (this.deps.detect ?? detectAgentInstallation)(harness.id, harness.path, environment);
            this.plans.set(harness.id, plan);
            if (failing) row = { ...row, ...broken(plan, null) };
            else {
              row = { ...row, method: plan.method, canUpdate: Boolean(plan.command), message: plan.message };
              row.latestVersion = await (this.deps.latest ?? fetchAgentRelease)(plan.releaseUrl);
              row.status = newerRelease(row.latestVersion, row.installedVersion!) ? "available" : "current";
            }
            row.checkedAt = Date.now();
          }
        } catch {
          row = {
            ...row,
            status: "error",
            message: row.installedVersion ? "Could not check this agent’s release. Check your connection and try again." : "Could not read this agent’s version. Check its installation and try again.",
          };
        }
        this.rows = this.rows.map((old) => (old.id === harness.id ? row : old));
        this.deps.changed();
      }),
    );
  }
  install(ids: HarnessId[]): Promise<AgentUpdates> {
    if (this.stopped) return Promise.reject(new Error("OpenOrc is closing."));
    if (this.installing || this.checking) return Promise.reject(new Error("An agent update or check is already running. Wait for it to finish."));
    const selected = [...new Set(ids)].map((id) => this.rows.find((row) => row.id === id)!);
    if (selected.some((row) => !actionable.has(row.status) || !row.canUpdate)) return Promise.reject(new Error("Check for updates and select agents that can be updated here."));
    this.installing = Promise.resolve()
      .then(() => this.apply(selected))
      .finally(() => {
        this.installing = null;
        this.deps.changed();
      })
      .then(() => this.get());
    this.deps.changed();
    return this.installing;
  }
  private async apply(selected: AgentUpdate[]): Promise<void> {
    const release = await this.deps.reserve();
    try {
      // Serial execution avoids racing shared package managers; a failure does not hide the other results.
      for (const row of selected) {
        this.patch(row.id, { status: row.status === "broken" ? "reinstalling" : "updating", message: null });
        try {
          this.patch(row.id, await this.execute(row));
        } catch (error) {
          this.patch(row.id, { status: "error", message: error instanceof Error ? error.message : "The update failed. Check again to retry." });
        }
      }
    } finally {
      release();
      this.deps.refreshed?.();
    }
  }
  /** Runs the update, or the reinstall for a broken row, that the last check planned for this installation. */
  private async execute(row: AgentUpdate): Promise<Partial<AgentUpdate>> {
    const repair = row.status === "broken";
    const harness = harnessInfo(await this.deps.info(true), row.id);
    if (!harness.path) throw new Error("This agent is no longer installed. Check for updates again.");
    const environment = this.deps.environment();
    const plan = await (this.deps.detect ?? detectAgentInstallation)(row.id, harness.path, environment);
    const previous = this.plans.get(row.id);
    const command = repair ? plan.repair : plan.command;
    if (!command || plan.identity !== previous?.identity || JSON.stringify(command) !== JSON.stringify(repair ? previous.repair : previous.command))
      throw new Error("The installation changed. Check for updates again before updating.");
    await (this.deps.run ?? runUpdateCommand)(command, { ...environment.env });
    return outcome(row, plan, harnessInfo(await this.deps.info(true), row.id));
  }
  private patch(id: HarnessId, patch: Partial<AgentUpdate>): void {
    this.rows = this.rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
    this.deps.changed();
  }
}
