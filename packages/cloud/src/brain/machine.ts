import { createHash } from "node:crypto";
import path from "node:path";
import { APIError, Sandbox as SdkSandbox } from "@vercel/sandbox";
import type { SandboxInfo } from "../sandbox.js";
import { STATES, type VercelCredentials } from "../vercel-sandbox.js";
import { ensureVercelProject, findVercelProject } from "../vercel-projects.js";
import { BRAIN_AWAY_MS, BRAIN_EXIT, BRAIN_PORT, BRAIN_PROJECT, BRAIN_READY, BRAIN_SANDBOX, brainLayout, type BrainLayout } from "./layout.js";
import { alreadyStopping } from "./self.js";
import { brainKeyText, encodeLaunch, parseControlReply, type BrainControlRequest, type BrainControlResult, type BrainKey } from "./wire.js";

/** The brain's folder under its sandbox's working folder. */
const ROOT_FOLDER = "openorc-brain";
/** A version names a folder beside `current`, `current.next` and `<version>.partial`, so it holds no dot. */
const VERSION = /^[A-Za-z0-9_-]{1,64}$/;
const START_MS = 45_000;
const POLL_MS = 1000;

export interface BrainAccess {
  token: string;
  teamId: string;
  /** BRAIN_SANDBOX unless given. */
  sandbox?: string;
}

/** What apps/brain's build makes: an archive whose top level holds the entry points. */
export interface BrainBundle {
  version: string;
  archive: Buffer;
}

export interface ProvisionOptions {
  /** Applies when the sandbox is made, as does the size. */
  region?: string;
  /** vCPUs for the brain itself; 1 unless given. */
  vcpus?: number;
}

export type WakeResult =
  | { state: "ready"; address: string; version: string }
  /** No sandbox, no bundle, or the machine lost what the brain needs: provision again. */
  | { state: "needs-provision"; detail: string }
  /** The key does not open this brain's secrets. Nothing was touched. */
  | { state: "wrong-key" }
  | { state: "failed"; detail: string };

export interface BrainMachineStatus {
  state: SandboxInfo["state"] | "missing";
  address: string | null;
  expiresAt: number | null;
}

/** The sandbox settings a brain needs. Compared on every provision, so brains made before a change get it too. */
export interface BrainSettings {
  ports: number[];
  timeout: number | undefined;
  snapshotExpiration: number | undefined;
  keepLastSnapshots: { count: number; expiration: number | undefined } | undefined;
}

/** A brain never loses its disk to expiry, and keeps one snapshot back for a rollback. */
const SETTINGS: BrainSettings = { ports: [BRAIN_PORT], timeout: BRAIN_AWAY_MS, snapshotExpiration: 0, keepLastSnapshots: { count: 2, expiration: 0 } };

export interface BrainCommand {
  wait(options?: { signal?: AbortSignal }): Promise<{ exitCode: number; stdout(): Promise<string>; stderr(): Promise<string> }>;
  logs(options?: { signal?: AbortSignal }): AsyncIterable<{ stream: "stdout" | "stderr"; data: string }>;
  writeStdin(data: string): Promise<void>;
  closeStdin(): Promise<void>;
}

/** The parts of the brain's Vercel sandbox this module uses. */
export interface BrainVm {
  readonly cwd: string;
  readonly state: SandboxInfo["state"];
  readonly expiresAt: Date | undefined;
  readonly settings: BrainSettings;
  /** The public origin of a declared port, such as https://sb-x.vercel.run; null for a port the sandbox does not declare. */
  domain(port: number): string | null;
  update(changes: Partial<BrainSettings>): Promise<void>;
  runCommand(params: { cmd: string; args: string[]; cwd: string; sudo?: boolean; detached: true; stdin?: boolean }): Promise<BrainCommand>;
  writeFiles(files: { path: string; content: Uint8Array }[]): Promise<void>;
  delete(options: { deleteOrphanSnapshots: true }): Promise<void>;
}

export interface BrainOpenParams extends VercelCredentials {
  name: string;
  persistent: true;
  ports: number[];
  timeout: number;
  snapshotExpiration: number;
  keepLastSnapshots: { count: number; expiration: number };
  resources: { vcpus: number };
  region?: string;
}

/** How a brain machine reaches Vercel. Tests pass a stand-in; everyone else the SDK. */
export interface BrainApi {
  project(token: string, teamId: string, name: string): Promise<{ id: string }>;
  /** The project without making it; null when the team has none. */
  findProject(token: string, teamId: string, name: string): Promise<{ id: string } | null>;
  /** Makes the sandbox when it is missing; either way it runs when this returns. */
  open(params: BrainOpenParams): Promise<BrainVm>;
  /**
   * Null when the sandbox does not exist. Wakes it only when asked to. Its commands run in the session it found, and fail
   * once that stops: asking never wakes a sleeping brain, and a wake that a sleep races resumes again itself.
   */
  get(params: VercelCredentials & { name: string; resume: boolean }): Promise<BrainVm | null>;
  /** The names of every sandbox in the project. */
  list(params: VercelCredentials): Promise<string[]>;
}

function brainVm(sandbox: SdkSandbox, resumes: boolean): BrainVm {
  return {
    get cwd() {
      return sandbox.cwd;
    },
    get state() {
      return STATES[sandbox.status];
    },
    get expiresAt() {
      return sandbox.expiresAt;
    },
    get settings() {
      const keep = sandbox.keepLastSnapshots;
      return {
        ports: sandbox.routes.map((route) => route.port),
        timeout: sandbox.timeout,
        snapshotExpiration: sandbox.snapshotExpiration,
        keepLastSnapshots: keep && { count: keep.count, expiration: keep.expiration },
      };
    },
    domain: (port) => (sandbox.routes.some((route) => route.port === port) ? sandbox.domain(port) : null),
    update: (changes) => sandbox.update(changes),
    // The sandbox's own runCommand resumes it once stopped, as when it stops between a look and a command.
    runCommand: (params) => (resumes ? sandbox.runCommand(params) : sandbox.currentSession().runCommand(params)),
    writeFiles: (files) => sandbox.writeFiles(files),
    delete: (options) => sandbox.delete(options),
  };
}

const sdk: BrainApi = {
  project: ensureVercelProject,
  findProject: findVercelProject,
  open: async (params) => brainVm(await SdkSandbox.getOrCreate({ ...params, resume: true }), true),
  get: async ({ name, resume, token, teamId, projectId }) => {
    try {
      return brainVm(await SdkSandbox.get({ name, resume, token, teamId, projectId }), false);
    } catch (error) {
      if (error instanceof APIError && error.response.status === 404) return null;
      throw error;
    }
  },
  list: async ({ token, teamId, projectId }) => (await (await SdkSandbox.list({ projectId, token, teamId })).toArray()).map((sandbox) => sandbox.name),
};

/** How setup supplies each thing the survey can find missing. */
type Remedy = { kind: "image" } | { kind: "apt"; package: string } | { kind: "folders" } | { kind: "npm"; package: string };

/** Checks run with `$npm` set and the layout's folders as arguments. */
const NEEDS = {
  node24: { check: `node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'`, remedy: { kind: "image" } },
  ps: { check: "command -v ps", remedy: { kind: "apt", package: "procps" } },
  flock: { check: "command -v flock", remedy: { kind: "apt", package: "util-linux" } },
  git: { check: "command -v git", remedy: { kind: "apt", package: "git" } },
  tar: { check: "command -v tar", remedy: { kind: "apt", package: "tar" } },
  folders: { check: 'for folder in "$@"; do test -d "$folder" || exit 1; done', remedy: { kind: "folders" } },
  claude: { check: '"$npm/bin/claude" --version', remedy: { kind: "npm", package: "@anthropic-ai/claude-code" } },
  codex: { check: '"$npm/bin/codex" --version', remedy: { kind: "npm", package: "@openai/codex" } },
} satisfies Record<string, { check: string; remedy: Remedy }>;
type Need = keyof typeof NEEDS;
const isNeed = (name: string): name is Need => Object.hasOwn(NEEDS, name);

/** What a read-only look at the machine found: what setup must supply, and which bundle is installed and current. */
interface Survey {
  missing: Need[];
  current: string | null;
  /** The sha256 recorded in the version folder being provisioned, when it is there. */
  installed: string | null;
}

/** One shell script run as `sh -c <script> <label> ...args`; the label names it in `ps` and in errors. */
interface Step {
  label: string;
  what: string;
  script: string;
  sudo?: true;
}

const lines = (...parts: string[]) => parts.join("\n");

const STEPS = {
  survey: {
    label: "brain-survey",
    what: "look over the machine",
    script: lines(
      "current=$1 app=$2 npm=$3",
      "shift 3",
      ...Object.entries(NEEDS).map(([need, { check }]) => `(${check}) >/dev/null 2>&1 || echo missing:${need}`),
      `printf 'current:%s\\n' "$(readlink "$current" 2>/dev/null)"`,
      `if test -f "$app/.sha256"; then printf 'installed:%s\\n' "$(cat "$app/.sha256")"; fi`,
    ),
  },
  apt: { label: "brain-apt", what: "install system packages", script: 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"', sudo: true },
  folders: { label: "brain-folders", what: "make the brain's folders", script: 'mkdir -p "$@" && chmod 700 "$1"' },
  // As the default user, never sudo: the brain's agent updates later run the same install as the same user.
  npm: { label: "brain-npm", what: "install the agent CLIs", script: lines('export NPM_CONFIG_PREFIX="$1"', "shift", 'npm install --global --no-audit --no-fund "$@"') },
  unpack: {
    label: "brain-unpack",
    what: "unpack the brain",
    script: lines(
      "set -e",
      "app=$1 archive=$2 sha=$3 entry=$4",
      'rm -rf "$app.partial"',
      'mkdir -p "$app.partial"',
      'tar -xzf "$archive" -C "$app.partial"',
      'test -f "$app.partial/$entry" || { echo "The bundle has no $entry." >&2; exit 1; }',
      'printf %s "$sha" > "$app.partial/.sha256"',
      'rm -rf "$app"',
      'mv "$app.partial" "$app"',
      'rm -f "$archive"',
    ),
  },
  // Swaps `current` atomically, then keeps only it, the new version and the versions named after it.
  switch: {
    label: "brain-switch",
    what: "switch the brain's version",
    script: lines(
      "set -e",
      "apps=$1 version=$2",
      "shift 2",
      'cd "$apps"',
      'ln -sfn "$version" current.next',
      "mv -T current.next current",
      "for entry in *; do",
      "  keep=",
      '  for kept in current "$version" "$@"; do test "$entry" = "$kept" && keep=1; done',
      '  test -n "$keep" || rm -rf -- "$entry"',
      "done",
    ),
  },
  // Both read their one line before anything can end them, so the line never races an early exit. printf is the
  // shell's own, so the line reaches node through a pipe and never through an argv.
  start: {
    label: "brain-start",
    what: "start the brain",
    script: lines(
      `IFS= read -r start || exit ${BRAIN_EXIT.badStart}`,
      `cd "$1" 2>/dev/null && test -e "$2" && test -d "\${3%/*}" || exit ${BRAIN_EXIT.needsProvision}`,
      `printf '%s\\n' "$start" | flock -n -E ${BRAIN_EXIT.alreadyRunning} "$3" node "$2" serve`,
    ),
  },
  ctl: {
    label: "brain-ctl",
    what: "ask the brain",
    script: lines(`IFS= read -r request || exit ${BRAIN_EXIT.badStart}`, `test -e "$1" || exit ${BRAIN_EXIT.unavailable}`, `printf '%s\\n' "$request" | node "$1"`),
  },
} satisfies Record<string, Step>;

function parseSurvey(stdout: string): Survey {
  const survey: Survey = { missing: [], current: null, installed: null };
  for (const line of stdout.split("\n")) {
    const colon = line.indexOf(":");
    const [tag, value] = [line.slice(0, colon), line.slice(colon + 1).trim()];
    if (tag === "missing" && isNeed(value)) survey.missing.push(value);
    else if (tag === "current" && value) survey.current = value;
    else if (tag === "installed" && value) survey.installed = value;
  }
  return survey;
}

function packages(missing: Need[], kind: "apt" | "npm"): string[] {
  return missing.flatMap((need) => {
    const remedy: Remedy = NEEDS[need].remedy;
    return "package" in remedy && remedy.kind === kind ? [remedy.package] : [];
  });
}

function drift(current: BrainSettings): Partial<BrainSettings> {
  const keys = Object.keys(SETTINGS) as (keyof BrainSettings)[];
  return Object.fromEntries(keys.filter((key) => JSON.stringify(current[key]) !== JSON.stringify(SETTINGS[key])).map((key) => [key, SETTINGS[key]]));
}

const hostOf = (domain: string | null) => (domain ? new URL(domain).host : null);
const tail = (text: string) => text.trim().split("\n").slice(-20).join("\n").slice(-1500);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Hands a started command its one line, then closes its input without waiting on that: the command acts on the line,
 * and every request here is a round trip through Vercel's API. After its line a command may have exited already, such
 * as on finding another brain running, so the close may fail; its exit says why. Rejects when the line was not written.
 */
function send(command: BrainCommand, line: string): Promise<void> {
  const written = command.writeStdin(`${line}\n`);
  void written.then(
    () => command.closeStdin().catch(() => undefined),
    () => undefined,
  );
  return written;
}

/** A command's whole output, read as it runs, so it is there when the command exits without another request. */
async function output(command: BrainCommand, signal: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  const text = { stdout: "", stderr: "" };
  for await (const entry of command.logs({ signal })) text[entry.stream] += entry.data;
  return text;
}

/** The brain's sandbox is not running, or no brain answers in it. */
export class BrainUnavailable extends Error {
  constructor() {
    super("The cloud brain is not running.");
  }
}

type Started = { kind: "ready"; version: string } | { kind: "exit"; code: number; stderr: () => Promise<string> } | { kind: "timeout" };
type Waited = { kind: "ready"; version: string } | { kind: "gone" } | { kind: "timeout" };

const TIMED_OUT: WakeResult = { state: "failed", detail: "The brain did not start in time." };
/** A brain sleeping as the wake landed stopped its sandbox under one of the wake's steps. */
const STOPPED_UNDER = "stopped-under";
const EXITS: Partial<Record<number, (detail: string) => WakeResult>> = {
  [BRAIN_EXIT.wrongKey]: () => ({ state: "wrong-key" }),
  [BRAIN_EXIT.needsProvision]: (detail) => ({ state: "needs-provision", detail: detail || "No brain is installed on its sandbox." }),
  [BRAIN_EXIT.badStart]: () => ({ state: "failed", detail: "The brain could not read its start line." }),
};

/** The first `BRAIN_READY` line on the command's stdout, as its version; null when the output ends without one. */
async function readyVersion(command: BrainCommand, signal: AbortSignal): Promise<string | null> {
  let pending = "";
  for await (const entry of command.logs({ signal })) {
    if (entry.stream !== "stdout") continue;
    const parts = (pending + entry.data).split("\n");
    pending = parts.pop() ?? "";
    const ready = parts.find((line) => line.startsWith(`${BRAIN_READY} `));
    if (ready) return ready.slice(BRAIN_READY.length + 1).trim();
  }
  return null;
}

export interface BrainMachineOptions {
  api?: BrainApi;
  /** How long a wake waits for the brain to be ready. */
  startMs?: number;
  /** How often a wake asks a brain that is starting or closing how it is. */
  pollMs?: number;
}

/** The cloud brain's sandbox, from outside it. Every method is safe to repeat, and `wake` is the only way a brain starts. */
export class BrainMachine {
  private constructor(
    private readonly credentials: VercelCredentials,
    private readonly name: string,
    private readonly api: BrainApi,
    private readonly timing: { startMs: number; pollMs: number },
  ) {}

  /** Finds or makes the brain's project. Wakes nothing. */
  static async connect(access: BrainAccess, options: BrainMachineOptions = {}): Promise<BrainMachine> {
    const api = options.api ?? sdk;
    return BrainMachine.at(access, await api.project(access.token, access.teamId, BRAIN_PROJECT), api, options);
  }

  /** As connect, but never makes the project: null when the team has none, and so no brain. */
  static async find(access: BrainAccess, options: BrainMachineOptions = {}): Promise<BrainMachine | null> {
    const api = options.api ?? sdk;
    const project = await api.findProject(access.token, access.teamId, BRAIN_PROJECT);
    return project && BrainMachine.at(access, project, api, options);
  }

  private static at(access: BrainAccess, project: { id: string }, api: BrainApi, options: BrainMachineOptions): BrainMachine {
    const credentials = { token: access.token, teamId: access.teamId, projectId: project.id };
    return new BrainMachine(credentials, access.sandbox ?? BRAIN_SANDBOX, api, { startMs: options.startMs ?? START_MS, pollMs: options.pollMs ?? POLL_MS });
  }

  /**
   * Makes the sandbox if missing, sets up the machine and installs the bundle. A second run with the same bundle writes
   * nothing. A running brain keeps its version until its next start, so `running` may differ from `installed`.
   */
  async provision(bundle: BrainBundle, options: ProvisionOptions = {}): Promise<{ installed: string; running: string | null }> {
    if (!VERSION.test(bundle.version) || bundle.version === "current") throw new Error("A brain bundle's version must be letters, digits, - or _, and not current.");
    const vm = await this.api.open({
      ...this.credentials,
      name: this.name,
      persistent: true,
      ports: SETTINGS.ports,
      timeout: BRAIN_AWAY_MS,
      snapshotExpiration: 0,
      keepLastSnapshots: { count: 2, expiration: 0 },
      resources: { vcpus: options.vcpus ?? 1 },
      ...(options.region ? { region: options.region } : {}),
    });
    const changes = drift(vm.settings);
    if (Object.keys(changes).length) await vm.update(changes);
    const layout = brainLayout(path.posix.join(vm.cwd, ROOT_FOLDER));
    const survey = await this.setup(vm, layout, bundle.version);
    const running = (await this.ask(vm, layout, { op: "status" }))?.version ?? null;
    await this.install(vm, layout, bundle, survey, running);
    return { installed: bundle.version, running };
  }

  /**
   * Ensures the brain runs: wakes the sandbox, starts the brain unless one runs, and waits until it is ready. A brain
   * that crashed starts again, and so does one that slept as the wake landed, stopping its sandbox under it. The key
   * travels on the start command's stdin only.
   */
  async wake(input: { key: BrainKey; name: string; threadVcpus?: number }): Promise<WakeResult> {
    const first = await this.wakeOnce(input);
    if (first !== STOPPED_UNDER) return first;
    // Once: the brain this wake starts does not sleep under it.
    const again = await this.wakeOnce(input);
    return again === STOPPED_UNDER ? { state: "failed", detail: "The brain's sandbox stopped as the brain was started." } : again;
  }

  private async wakeOnce(input: { key: BrainKey; name: string; threadVcpus?: number }): Promise<WakeResult | typeof STOPPED_UNDER> {
    const vm = await this.api.get({ ...this.credentials, name: this.name, resume: true });
    if (!vm) return { state: "needs-provision", detail: "The brain's sandbox does not exist." };
    const address = hostOf(vm.domain(BRAIN_PORT));
    if (!address) return { state: "needs-provision", detail: `The brain's sandbox does not open port ${BRAIN_PORT}.` };
    const layout = brainLayout(path.posix.join(vm.cwd, ROOT_FOLDER));
    const connection = { ...this.credentials, ...(input.threadVcpus ? { vcpus: input.threadVcpus } : {}) };
    const line = encodeLaunch({ key: input.key, name: input.name, address, port: BRAIN_PORT, vercel: { connection, sandbox: this.name } });
    const secrets = [this.credentials.token, brainKeyText(input.key)];
    const deadline = Date.now() + this.timing.startMs;
    try {
      // A second try only after the first met a brain that was closing and has since exited.
      for (let tries = 0; tries < 2; tries++) {
        const started = await this.start(vm, layout, line, deadline);
        if (started.kind === "ready") return { state: "ready", address, version: started.version };
        if (started.kind === "timeout") return TIMED_OUT;
        if (started.code !== BRAIN_EXIT.alreadyRunning) return await this.exited(started, secrets);
        const running = await this.waitForBrain(vm, layout, deadline);
        if (running.kind === "ready") return { state: "ready", address, version: running.version };
        if (running.kind === "timeout") return TIMED_OUT;
      }
      return { state: "failed", detail: "The brain kept closing as it was started." };
    } catch (error) {
      if (alreadyStopping(error)) return STOPPED_UNDER;
      throw error;
    }
  }

  /** What a start's exit means, other than another brain holding the lock. */
  private async exited(started: Extract<Started, { kind: "exit" }>, secrets: string[]): Promise<WakeResult | typeof STOPPED_UNDER> {
    const known = EXITS[started.code];
    // An exit the brain did not choose may be its start going down with the sandbox.
    if (!known && (await this.api.get({ ...this.credentials, name: this.name, resume: false }))?.state !== "running") return STOPPED_UNDER;
    const detail = tail(scrub(await started.stderr(), secrets));
    return known?.(detail) ?? { state: "failed", detail: detail || `The brain exited with ${started.code}.` };
  }

  /** One request to the running brain, without waking its sandbox. Throws BrainUnavailable when no brain answers. */
  async control<R extends BrainControlRequest>(request: R): Promise<BrainControlResult<R>> {
    const vm = await this.api.get({ ...this.credentials, name: this.name, resume: false });
    if (vm?.state !== "running") throw new BrainUnavailable();
    const result = await this.ask(vm, brainLayout(path.posix.join(vm.cwd, ROOT_FOLDER)), request).catch((error: unknown) => {
      // It stopped between the look and the request, and asking did not wake it.
      if (alreadyStopping(error)) return null;
      throw error;
    });
    if (!result) throw new BrainUnavailable();
    return result;
  }

  /** Without waking it. */
  async status(): Promise<BrainMachineStatus> {
    const vm = await this.api.get({ ...this.credentials, name: this.name, resume: false });
    if (!vm) return { state: "missing", address: null, expiresAt: null };
    return { state: vm.state, address: hostOf(vm.domain(BRAIN_PORT)), expiresAt: vm.expiresAt?.getTime() ?? null };
  }

  /** Deletes every sandbox in the brain's project, the brain's and its threads', with the snapshots only they used. */
  async remove(): Promise<void> {
    const names = await this.api.list(this.credentials);
    // The brain first, so it cannot make a thread sandbox again while the rest go.
    for (const name of [this.name, ...names.filter((other) => other !== this.name)]) {
      const vm = await this.api.get({ ...this.credentials, name, resume: false });
      await vm?.delete({ deleteOrphanSnapshots: true });
    }
  }

  private async run(vm: BrainVm, step: Step, args: string[]): Promise<string> {
    const command = await vm.runCommand({ cmd: "sh", args: ["-c", step.script, step.label, ...args], cwd: vm.cwd, ...(step.sudo ? { sudo: true } : {}), detached: true });
    const done = await command.wait();
    if (done.exitCode !== 0) throw new Error(`Could not ${step.what} on its sandbox: ${tail(scrub(await done.stderr(), [this.credentials.token])) || `exit ${done.exitCode}`}`);
    return done.stdout();
  }

  private async survey(vm: BrainVm, layout: BrainLayout, version: string): Promise<Survey> {
    return parseSurvey(await this.run(vm, STEPS.survey, [layout.current, layout.app(version), layout.npm, layout.root, ...layout.folders]));
  }

  /** Check, then act: supplies only what the survey found missing, then looks again. */
  private async setup(vm: BrainVm, layout: BrainLayout, version: string): Promise<Survey> {
    const survey = await this.survey(vm, layout, version);
    if (!survey.missing.length) return survey;
    if (survey.missing.includes("node24")) throw new Error("The brain's sandbox has no Node 24 or newer. Its image changed, and setup cannot fix that.");
    const apt = packages(survey.missing, "apt");
    if (apt.length) await this.run(vm, STEPS.apt, apt);
    if (survey.missing.includes("folders")) await this.run(vm, STEPS.folders, [layout.root, ...layout.folders]);
    const npm = packages(survey.missing, "npm");
    if (npm.length) await this.run(vm, STEPS.npm, [layout.npm, ...npm]);
    const after = await this.survey(vm, layout, version);
    if (after.missing.length) throw new Error(`The brain's sandbox still lacks ${after.missing.join(", ")} after setup.`);
    return after;
  }

  private async install(vm: BrainVm, layout: BrainLayout, bundle: BrainBundle, survey: Survey, running: string | null): Promise<void> {
    const sha256 = createHash("sha256").update(bundle.archive).digest("hex");
    const fresh = survey.installed !== sha256;
    if (fresh) {
      const archive = path.posix.join(layout.inbox, `brain-${bundle.version}.tgz`);
      await vm.writeFiles([{ path: archive, content: bundle.archive }]);
      await this.run(vm, STEPS.unpack, [layout.app(bundle.version), archive, sha256, path.posix.basename(layout.serve)]);
    }
    if (!fresh && survey.current === bundle.version) return;
    const keep = [survey.current, running].filter((version): version is string => version !== null);
    await this.run(vm, STEPS.switch, [layout.apps, bundle.version, ...keep]);
  }

  /** One control request through `ctl`: the request on stdin, the reply on its last stdout line. Null when no brain answers. */
  private async ask<R extends BrainControlRequest>(vm: BrainVm, layout: BrainLayout, request: R): Promise<BrainControlResult<R> | null> {
    const command = await vm.runCommand({ cmd: "sh", args: ["-c", STEPS.ctl.script, STEPS.ctl.label, layout.ctl], cwd: vm.cwd, detached: true, stdin: true });
    const stop = new AbortController();
    const [done, text] = await Promise.all([command.wait({ signal: stop.signal }), output(command, stop.signal), send(command, JSON.stringify(request))]).finally(() => stop.abort());
    if (done.exitCode === BRAIN_EXIT.unavailable) return null;
    const line = text.stdout.trim().split("\n").pop() ?? "";
    if (!line) throw new Error(`The brain did not answer ${request.op}: ${tail(scrub(text.stderr, [this.credentials.token])) || `exit ${done.exitCode}`}`);
    const reply = parseControlReply<R["op"]>(request.op, line);
    if (!reply.ok) throw new Error(reply.error);
    return reply.result;
  }

  /** One start: the first of its ready line, its exit, or the deadline. A brain that is ready keeps running. */
  private async start(vm: BrainVm, layout: BrainLayout, line: string, deadline: number): Promise<Started> {
    const command = await vm.runCommand({ cmd: "sh", args: ["-c", STEPS.start.script, STEPS.start.label, layout.root, layout.serve, layout.lock], cwd: vm.cwd, detached: true, stdin: true });
    const stop = new AbortController();
    try {
      return await new Promise<Started>((resolve, reject) => {
        const timer = setTimeout(() => resolve({ kind: "timeout" }), Math.max(0, deadline - Date.now()));
        stop.signal.addEventListener("abort", () => clearTimeout(timer));
        void readyVersion(command, stop.signal)
          .then((version) => version && resolve({ kind: "ready", version }))
          .catch(() => undefined);
        void command.wait({ signal: stop.signal }).then(
          (done) => resolve({ kind: "exit", code: done.exitCode, stderr: () => done.stderr() }),
          // Anything else may pass while the ready line still comes; a stopping sandbox will not send it.
          (error: unknown) => alreadyStopping(error) && reject(error),
        );
        send(command, line).catch(reject);
      });
    } finally {
      stop.abort();
    }
  }

  /** Asks a brain that holds the lock how it is, until it is ready, has exited, or the deadline passes. */
  private async waitForBrain(vm: BrainVm, layout: BrainLayout, deadline: number): Promise<Waited> {
    for (;;) {
      const status = await this.ask(vm, layout, { op: "wake" });
      if (!status) return { kind: "gone" };
      if (status.state === "ready") return { kind: "ready", version: status.version };
      if (Date.now() + this.timing.pollMs >= deadline) return { kind: "timeout" };
      await delay(this.timing.pollMs);
    }
  }
}

function scrub(text: string, secrets: string[]): string {
  return secrets.reduce((out, secret) => (secret ? out.replaceAll(secret, "[redacted]") : out), text);
}
