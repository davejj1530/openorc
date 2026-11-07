import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { releaseOf } from "@openorc/agents";
import { BASE_PREFIX, branchHead, ensureAgent, installRunner, runRunner, writeBaseMarker, type RunnerFile, type Sandbox, type SandboxProvider, type WorkspaceLocation } from "@openorc/cloud";
import { projects, settings, type CloudProviderId, type Db } from "@openorc/db";
import { defaultBranch, git, originUrl } from "@openorc/git";
import { harnessCatalog, harnessIds, type HarnessId, type Project } from "@openorc/protocol";
import type { Logger } from "../transport.js";
import { Phases } from "./cloud-phases.js";

/** A project's base on one service: a saved sandbox new conversations start from, its code there and its setup done. */
export interface CloudBase {
  project: string;
  provider: CloudProviderId;
  docker: boolean;
  /** The service's id for it: a Vercel snapshot, a folder on this Mac. */
  image: string;
  /** The default branch's commit its checkout holds. */
  commit: string;
  branch: string;
  /** What it was made with; a base made with anything else is not used. */
  key: string;
  builtAt: number;
  /** Bases this one replaced, deleted once no sandbox can still be starting from them. */
  retired?: { image: string; at: number }[];
}

type Bases = Record<string, CloudBase>;

const SETTING = "cloud.bases";
/** A moved default branch makes a new base at most this often, unless what the setup installs from changed. */
const REFRESH_MS = 60 * 60_000;
/** After a base could not be made, the next try waits this long. */
const RETRY_MS = 30 * 60_000;
/** How long a replaced base stays, for a sandbox already starting from it. */
const RETIRE_MS = 10 * 60_000;
const SETUP_OUTPUT_TAIL = 2000;

/** Files a project's setup usually installs from: when one changes, a checkout over an older base runs its setup again. */
const SETUP_INPUTS = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  ".yarnrc.yml",
  "bun.lock",
  "bun.lockb",
  ".npmrc",
  ".nvmrc",
  ".node-version",
  ".tool-versions",
  "requirements.txt",
  "pyproject.toml",
  "poetry.lock",
  "uv.lock",
  "Pipfile",
  "Pipfile.lock",
  "Gemfile",
  "Gemfile.lock",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
  "composer.json",
  "composer.lock",
  "mix.exs",
  "mix.lock",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  "flake.nix",
  "flake.lock",
]);

const at = (project: string, provider: CloudProviderId, docker: boolean) => `${project}:${provider}:${docker ? "docker" : "plain"}`;
const words = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The setup script, by hash: what a base's marker records of it. */
export const setupHash = (script: string | null | undefined) => (script ? createHash("sha256").update(script).digest("hex") : "");

/** Whether a commit's setup could install other things than an older one's: what it installs from changed between them. */
export async function setupInputsChanged(root: string, from: string, to: string): Promise<boolean> {
  if (from === to) return false;
  const changed = await git(root, ["diff", "--name-only", from, to], { okCodes: [0, 128] });
  // A commit this repository no longer has: nothing says what changed, so the setup runs again.
  if (changed.code !== 0) return true;
  return changed.stdout.split("\n").some((file) => SETUP_INPUTS.has(path.posix.basename(file)) || file.startsWith(".devcontainer/"));
}

/** Runs the project's setup script in a sandbox's checkout, as for a conversation's own, with the project's environment. */
export async function runSetupScript(location: WorkspaceLocation, script: string, name: string, projectEnv: Record<string, string>): Promise<void> {
  const { repo } = location;
  const env = { ...projectEnv, OPENORC_WORKSPACE_PATH: repo, OPENORC_ROOT_PATH: repo, OPENORC_WORKSPACE_NAME: name, OPENORC_CLOUD: "1" };
  const result = await location.install.sandbox.exec("bash", ["-lc", script], { cwd: repo, env });
  if (result.code === 0) return;
  const output = `${result.stdout.toString("utf8")}${result.stderr}`.trim().slice(-SETUP_OUTPUT_TAIL);
  throw new Error(`The setup script failed in the cloud workspace (exit ${result.code ?? "signal"}).${output ? `\n${output}` : ""}`);
}

export interface CloudBasesDeps {
  db: Db;
  provider: (id: CloudProviderId) => SandboxProvider;
  files: () => RunnerFile[];
  node?: string | undefined;
  /** This host's agent CLI versions, which a base installs. */
  versions?: ((agent: HarnessId) => Promise<string | null>) | undefined;
  projectEnv: (projectId: string) => Promise<Record<string, string>>;
  log: Logger;
}

/**
 * Each project's base on each service, made ahead so a new conversation starts with its code, setup and agents in
 * place: only the commits since, and the turn's own sign-in, remain. Made in the background after a project's
 * conversation starts in the cloud, again when it was made with something else or its default branch moved on, and
 * never waited for: a conversation without a usable base starts the ordinary way.
 */
export class CloudBases {
  private readonly building = new Map<string, Promise<void>>();
  /** Bases asked for again while being made or looked at, so the ask is not lost. */
  private readonly again = new Set<string>();
  private readonly failedAt = new Map<string, number>();

  constructor(private readonly deps: CloudBasesDeps) {}

  private read(): Bases {
    const raw = settings.get(this.deps.db, SETTING);
    return raw ? (JSON.parse(raw) as Bases) : {};
  }

  private write(bases: Bases): void {
    settings.set(this.deps.db, SETTING, JSON.stringify(bases));
  }

  /** What a base of the project is made with today: its setup, this host's agents, and whether it runs Docker. */
  private async key(project: Project, docker: boolean): Promise<string> {
    const versions = await Promise.all(harnessIds.map(async (agent) => [agent, (await this.deps.versions?.(agent)) ?? null] as const));
    return createHash("sha256")
      .update(JSON.stringify({ v: 1, setup: project.settings.setupScript ?? "", versions, docker }))
      .digest("hex");
  }

  /** The base a new conversation in `project` can start from now; null for none, as where the service keeps no bases. */
  async usable(project: Project, provider: CloudProviderId, docker: boolean): Promise<CloudBase | null> {
    if (!this.deps.provider(provider).bases) return null;
    const base = this.read()[at(project.id, provider, docker)];
    return base && base.key === (await this.key(project, docker)) ? base : null;
  }

  /** A base a sandbox could not start from, as one its service no longer has: a new one is made in its place. */
  forget(base: CloudBase): void {
    const { [at(base.project, base.provider, base.docker)]: gone, ...rest } = this.read();
    if (gone?.image === base.image) this.write(rest);
    const project = projects.get(this.deps.db, base.project);
    if (project) this.refresh(project, base.provider, base.docker);
  }

  /** Makes the project's base in the background when it has none, or a stale one; one at a time, never waited for. */
  refresh(project: Project, provider: CloudProviderId, docker: boolean): void {
    const id = at(project.id, provider, docker);
    if (!this.deps.provider(provider).bases || Date.now() - (this.failedAt.get(id) ?? 0) < RETRY_MS) return;
    if (this.building.has(id)) return void this.again.add(id);
    const building = (async () => {
      if (await this.stale(project, provider, docker)) await this.build(project, provider, docker);
      await this.prune(provider);
    })()
      .catch((error: unknown) => {
        this.failedAt.set(id, Date.now());
        this.deps.log.warn(`the cloud base of project ${project.name} on ${provider} could not be made: ${words(error)}`);
      })
      .finally(() => {
        this.building.delete(id);
        if (this.again.delete(id)) this.refresh(project, provider, docker);
      });
    this.building.set(id, building);
  }

  /** Waits for the bases being made, those asked for meanwhile too, as before closing or in a check. */
  async settled(): Promise<void> {
    while (this.building.size) await Promise.all([...this.building.values()]);
  }

  private async stale(project: Project, provider: CloudProviderId, docker: boolean): Promise<boolean> {
    const base = this.read()[at(project.id, provider, docker)];
    if (!base || base.key !== (await this.key(project, docker))) return true;
    const head = await branchHead(project.rootPath, base.branch).catch(() => null);
    if (!head || head === base.commit) return false;
    return Date.now() - base.builtAt > REFRESH_MS || (await setupInputsChanged(project.rootPath, base.commit, head));
  }

  private async build(project: Project, provider: CloudProviderId, docker: boolean): Promise<void> {
    const service = this.deps.provider(provider);
    const bases = service.bases!;
    const branch = project.defaultBranch ?? (await defaultBranch(project.rootPath).catch(() => null));
    if (!branch) throw new Error("It has no default branch.");
    const key = await this.key(project, docker);
    const phases = new Phases();
    const name = `${BASE_PREFIX}${randomUUID()}`;
    const sandbox = await phases.time("vm", () => service.open(name, { docker }));
    try {
      const install = await phases.time("runner", () => installRunner(sandbox, this.deps.files(), this.deps.node));
      const location: WorkspaceLocation = { install, repo: path.posix.join(sandbox.root, "repo"), mirror: project.rootPath, refPrefix: "refs/openorc/base/" };
      if (docker) await phases.time("docker", async () => sandbox.startDocker?.());
      const commit = await phases.time("code", () => seedBranch(location, project.rootPath, branch));
      const script = project.settings.setupScript;
      if (script) await phases.time("setup", async () => runSetupScript(location, script, project.name, await this.deps.projectEnv(project.id)));
      // A sandbox on this Mac runs the Mac's own CLIs.
      const agents = provider === "local" ? {} : await phases.time("agents", () => this.installAgents(sandbox));
      await sandbox.exec("rm", ["-f", path.posix.join(install.state, "seed.bundle")]);
      await writeBaseMarker(install, { commit, branch, setup: setupHash(script), agents });
      const image = await phases.time("save", () => bases.save(sandbox));
      const id = at(project.id, provider, docker);
      const previous = this.read()[id];
      const retired = [...(previous?.retired ?? []), ...(previous && previous.image !== image ? [{ image: previous.image, at: Date.now() }] : [])];
      this.write({ ...this.read(), [id]: { project: project.id, provider, docker, image, commit, branch, key, builtAt: Date.now(), retired } });
      this.deps.log.info(phases.line(`cloud base of project ${project.name} on ${provider} made at ${commit.slice(0, 12)}`));
    } catch (error) {
      await service.remove(name).catch(() => undefined);
      throw error;
    }
  }

  /** Each agent CLI at this host's version, so a conversation's first turn installs nothing. */
  private async installAgents(sandbox: Sandbox): Promise<Partial<Record<HarnessId, string>>> {
    const agents: Partial<Record<HarnessId, string>> = {};
    for (const agent of harnessIds) {
      const version = (await this.deps.versions?.(agent)) ?? null;
      if (!version) continue;
      const { cli, name } = harnessCatalog[agent];
      // One that cannot be installed here is installed at its conversation's first turn, as without a base.
      const ready = await ensureAgent(sandbox, cli, { name, mayInstall: true, version, read: releaseOf }).then(
        () => true,
        (error: unknown) => (this.deps.log.warn(`${name} is left out of a cloud base: ${words(error)}`), false),
      );
      if (ready) agents[agent] = version;
    }
    return agents;
  }

  /** Deletes the bases of projects no longer on this host, and replaced ones once nothing can be starting from them. */
  private async prune(provider: CloudProviderId): Promise<void> {
    const service = this.deps.provider(provider).bases;
    if (!service) return;
    const remove = (image: string) =>
      service.remove(image).then(
        () => true,
        (error: unknown) => (this.deps.log.warn(`a cloud base on ${provider} could not be deleted: ${words(error)}`), false),
      );
    const now = Date.now();
    for (const [id, base] of Object.entries(this.read()).filter(([, each]) => each.provider === provider)) {
      if (!projects.get(this.deps.db, base.project)) {
        const images = [base.image, ...(base.retired ?? []).map((old) => old.image)];
        if ((await Promise.all(images.map(remove))).every(Boolean)) this.write(Object.fromEntries(Object.entries(this.read()).filter(([other]) => other !== id)));
        continue;
      }
      const due = (base.retired ?? []).filter((old) => now - old.at >= RETIRE_MS);
      if (!due.length) continue;
      const deleted = new Set<string>();
      for (const old of due) if (await remove(old.image)) deleted.add(old.image);
      const current = this.read()[id];
      if (current) this.write({ ...this.read(), [id]: { ...current, retired: (current.retired ?? []).filter((old) => !deleted.has(old.image)) } });
    }
  }
}

/** Gives a checkout the branch with its history, as a base's or a sandbox made ahead holds it, and says which commit. */
export async function seedBranch(location: WorkspaceLocation, source: string, branch: string): Promise<string> {
  const { install, repo } = location;
  const commit = (await git(source, ["rev-parse", `refs/heads/${branch}^{commit}`])).stdout.trim();
  const origin = (await originUrl(source)) ?? undefined;
  const dir = await mkdtemp(path.join(os.tmpdir(), "openorc-base-"));
  try {
    const bundle = path.join(dir, "seed.bundle");
    await git(source, ["bundle", "create", "-q", bundle, `refs/heads/${branch}`]);
    const remoteBundle = path.posix.join(install.state, "seed.bundle");
    await install.sandbox.writeFile(remoteBundle, await readFile(bundle));
    await runRunner(install, "seed", ["--repo", repo, "--bundle", remoteBundle, "--branch", branch, ...(origin ? ["--origin", origin] : [])]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return commit;
}
