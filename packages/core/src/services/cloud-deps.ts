import path from "node:path";
import { RUNNER_BIN, type RunnerInstall } from "@openorc/cloud";
import { git } from "@openorc/git";
import type { Project } from "@openorc/protocol";

type Manager = "pnpm" | "yarn" | "npm" | "bun";

/** Each lockfile at a project's root, and the package manager it belongs to. */
const LOCKFILES: [string, Manager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
];
/** The commands that wait for the install; `node` and the rest run as they are. */
const WAITING = ["pnpm", "yarn", "npm", "npx", "bun"];
/** How long a package manager waits for the install before it runs anyway: 15 minutes, in half seconds. */
const WAIT_TICKS = 1800;

const quote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

async function exists(source: string, commit: string, file: string): Promise<boolean> {
  return (await git(source, ["cat-file", "-e", `${commit}:${file}`], { okCodes: [0, 1, 128] })).code === 0;
}

/** Yarn 2 and later take `--immutable`; Yarn 1 takes `--frozen-lockfile`. */
async function modernYarn(source: string, commit: string): Promise<boolean> {
  if (await exists(source, commit, ".yarnrc.yml")) return true;
  const manifest = await git(source, ["show", `${commit}:package.json`], { okCodes: [0, 128] });
  try {
    const named = (JSON.parse(manifest.stdout) as { packageManager?: unknown }).packageManager;
    return typeof named === "string" && /^yarn@([2-9]|\d{2,})/.test(named);
  } catch {
    return false;
  }
}

/**
 * The command that installs a project's dependencies at `commit` exactly as its lockfile pins them, for a project with no
 * setup script of its own; null without a lockfile at its root.
 */
export async function dependencyInstall(source: string, commit: string): Promise<string | null> {
  const found = await Promise.all(LOCKFILES.map(async ([file, manager]) => ((await exists(source, commit, file)) ? manager : null)));
  const manager = found.find((each) => each !== null);
  if (manager === "pnpm") return "pnpm install --frozen-lockfile";
  if (manager === "yarn") return (await modernYarn(source, commit)) ? "yarn install --immutable" : "yarn install --frozen-lockfile";
  if (manager === "npm") return "npm ci --no-audit --no-fund";
  if (manager === "bun") return "bun install --frozen-lockfile";
  return null;
}

interface InstallFiles {
  bin: string;
  log: string;
  exit: string;
  lock: string;
  corepack: string;
}

function installFiles(install: RunnerInstall): InstallFiles {
  const at = (name: string) => path.posix.join(install.state, name);
  return { bin: at(RUNNER_BIN), log: at("deps.log"), exit: at("deps.exit"), lock: at("deps.lock"), corepack: at("corepack") };
}

/**
 * A package manager in front of the sandbox's own, first on the agent's PATH: it waits for the install, then runs the
 * real one, through Corepack where the image has only that, with a Corepack cache the sandbox's user can write.
 */
function waitingCommand(files: InstallFiles): string {
  return [
    "#!/bin/sh",
    `if [ ! -e ${quote(files.exit)} ]; then`,
    `  echo "Waiting for OpenOrc to finish installing this project's dependencies (log: ${files.log})" >&2`,
    "  i=0",
    `  while [ ! -e ${quote(files.exit)} ] && [ "$i" -lt ${WAIT_TICKS} ]; do sleep 0.5; i=$((i + 1)); done`,
    "fi",
    `if [ -e ${quote(files.exit)} ] && [ "$(cat ${quote(files.exit)})" != 0 ]; then echo "OpenOrc could not install this project's dependencies; its output is in ${files.log}" >&2; fi`,
    `export COREPACK_HOME=${quote(files.corepack)} COREPACK_ENABLE_DOWNLOAD_PROMPT=0`,
    'name=$(basename "$0")',
    'here=$(cd "$(dirname "$0")" && pwd)',
    "IFS=:",
    "for dir in $PATH; do",
    '  [ "$dir" = "$here" ] && continue',
    '  if [ -x "$dir/$name" ]; then unset IFS; exec "$dir/$name" "$@"; fi',
    "done",
    "unset IFS",
    'case "$name" in pnpm | yarn) exec corepack "$name" "$@" ;; esac',
    'echo "$name: command not found" >&2',
    "exit 127",
    "",
  ].join("\n");
}

/** The install itself; one at a time in a sandbox, and its exit code where the waiting commands look for it. */
function installScript(files: InstallFiles, repo: string, command: string): string {
  return [
    `cd ${quote(repo)} || exit 1`,
    `until mkdir ${quote(files.lock)} 2>/dev/null; do sleep 1; done`,
    `trap 'rmdir ${quote(files.lock)}' EXIT`,
    'run() { if command -v "$1" >/dev/null 2>&1; then "$@"; else corepack "$@"; fi; }',
    `run ${command} > ${quote(files.log)} 2>&1`,
    `echo $? > ${quote(`${files.exit}.part`)} && mv ${quote(`${files.exit}.part`)} ${quote(files.exit)}`,
  ].join("\n");
}

/**
 * Installs the project's dependencies in the sandbox's checkout with `command`. Without `wait`, it returns once the
 * package managers there wait for the install: the agent starts meanwhile, and its first `pnpm test` runs when the
 * install is done. With it, it returns when the install has ended, true when it succeeded.
 */
export async function installDependencies(install: RunnerInstall, repo: string, command: string, env: Record<string, string>, wait: boolean): Promise<boolean> {
  const files = installFiles(install);
  const waiting = waitingCommand(files);
  const placed = await install.sandbox.exec("sh", [
    "-c",
    [
      `mkdir -p ${quote(files.bin)}`,
      `rm -f ${quote(files.exit)}`,
      ...WAITING.map((name) => `printf '%s' ${quote(waiting)} > ${quote(`${files.bin}/${name}`)} && chmod +x ${quote(`${files.bin}/${name}`)}`),
    ].join(" && "),
  ]);
  if (placed.code !== 0) throw new Error(`Could not put the waiting package managers in the sandbox. ${placed.stderr.trim()}`.trim());
  const options = { cwd: repo, env: { ...env, COREPACK_HOME: files.corepack, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", CI: "1" } };
  const script = installScript(files, repo, command);
  if (!wait) {
    await install.sandbox.launch("sh", ["-c", script], options);
    return true;
  }
  await install.sandbox.exec("sh", ["-c", script], options);
  return (await install.sandbox.exec("cat", [files.exit])).stdout.toString("utf8").trim() === "0";
}

/** What a project's checkout runs once its code is in: the project's own setup script, else installing its dependencies. */
export type CloudSetup = { kind: "script"; script: string } | { kind: "dependencies"; command: string };

export async function cloudSetup(project: Project, source: string, commit: string): Promise<CloudSetup | null> {
  const script = project.settings.setupScript;
  if (script) return { kind: "script", script };
  const command = await dependencyInstall(source, commit).catch(() => null);
  return command ? { kind: "dependencies", command } : null;
}

/** The setup as a base's marker records it, by hash. */
export const setupText = (setup: CloudSetup | null): string | null => (setup?.kind === "script" ? setup.script : (setup?.command ?? null));
