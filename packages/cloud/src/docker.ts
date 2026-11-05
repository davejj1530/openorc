import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Sandbox } from "./sandbox.js";

/** How long a daemon just started gets to answer, and how often it is asked. */
export interface DockerWait {
  timeoutMs: number;
  pollMs: number;
}

const WAIT: DockerWait = { timeoutMs: 60_000, pollMs: 1000 };
const LOG_LINES = 20;
const OUTPUT_TAIL = 2000;

/** Succeeds once the daemon answers whoever runs it. */
const ANSWERS = "docker info >/dev/null 2>&1";

/** Docker's daemon and Compose v2 are on the machine, under both of Compose's names. */
const INSTALLED = "command -v dockerd >/dev/null && docker compose version >/dev/null 2>&1 && command -v docker-compose >/dev/null";

/**
 * Installs Docker from the system's packages: Compose v2 and buildx under Ubuntu's names or, where they are, Docker's
 * own repository's. Safe to run again after a half install. A system with no Compose v2 to install fails at the end.
 */
const INSTALL = [
  "set -e",
  "export DEBIAN_FRONTEND=noninteractive",
  `command -v apt-get >/dev/null || { echo "This sandbox's Linux has no apt-get to install Docker with." >&2; exit 1; }`,
  // Where an init system runs, the packages would start their own daemon, with other settings, before ours.
  `if [ ! -e /usr/sbin/policy-rc.d ]; then printf '#!/bin/sh\\nexit 101\\n' > /usr/sbin/policy-rc.d && chmod +x /usr/sbin/policy-rc.d && trap 'rm -f /usr/sbin/policy-rc.d' EXIT; fi`,
  "apt-get update -q",
  // Pulling images needs the certificates the package only recommends.
  "apt-get install -y -q --no-install-recommends docker.io ca-certificates",
  // Debian 13 moved the docker command to a package of its own.
  "command -v docker >/dev/null || apt-get install -y -q --no-install-recommends docker-cli",
  `for name in docker-compose-v2 docker-compose-plugin; do docker compose version >/dev/null 2>&1 && break; apt-get install -y -q --no-install-recommends "$name" || true; done`,
  `for name in docker-buildx docker-buildx-plugin; do docker buildx version >/dev/null 2>&1 && break; apt-get install -y -q --no-install-recommends "$name" || true; done`,
  // Debian's own docker-compose is Compose v1 up to Debian 12; Docker's repository has v2 for Debian and Ubuntu alike.
  "if ! docker compose version >/dev/null 2>&1; then",
  "apt-get install -y -q --no-install-recommends curl",
  ". /etc/os-release",
  "install -d -m 0755 /etc/apt/keyrings",
  `curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc`,
  `echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list`,
  "apt-get update -q",
  "apt-get install -y -q --no-install-recommends docker-compose-plugin",
  "docker buildx version >/dev/null 2>&1 || apt-get install -y -q --no-install-recommends docker-buildx-plugin || true",
  "fi",
  // Projects that run docker-compose get Compose v2 as well.
  `if ! command -v docker-compose >/dev/null; then printf '#!/bin/sh\\nexec docker compose "$@"\\n' > /usr/local/bin/docker-compose && chmod +x /usr/local/bin/docker-compose; fi`,
  // Nor at the next boot, where the package's service would take the socket before ours.
  "if command -v systemctl >/dev/null; then systemctl disable --now docker.socket docker.service >/dev/null 2>&1 || true; fi",
  "docker compose version",
].join("\n");

/**
 * Starts the daemon as root unless one runs already, with `$1` its data root, `$2` the group whose members reach its
 * socket and `$3` the log its output is added to. A pid file left by a daemon that died with the VM would stop it.
 */
const START = [
  `for p in /proc/[0-9]*; do read -r name 2>/dev/null < "$p/comm" && [ "$name" = dockerd ] && exit 0; done`,
  "rm -f /var/run/docker.pid",
  `mkdir -p "$1"`,
  `exec dockerd --data-root "$1" --group "$2" >>"$3" 2>&1`,
].join("\n");

/** The end of `text`, from the start of a line. */
function tail(text: string): string {
  const end = text.trim().slice(-OUTPUT_TAIL);
  return end.length < OUTPUT_TAIL ? end : end.slice(end.indexOf("\n") + 1);
}

async function answers(sandbox: Sandbox): Promise<boolean> {
  return (await sandbox.exec("sh", ["-c", ANSWERS])).code === 0;
}

/**
 * Docker in `sandbox`, reachable by its normal user without sudo: installed the first time, its daemon started when it
 * is not running, its images kept with the workspace's files under `.openorc/docker`. Returns once `docker info`
 * answers; while it does, this is one command.
 */
export async function ensureDocker(sandbox: Sandbox, wait: DockerWait = WAIT): Promise<void> {
  if (await answers(sandbox)) return;
  if ((await sandbox.exec("sh", ["-c", INSTALLED], { sudo: true })).code !== 0) {
    const installed = await sandbox.exec("sh", ["-c", INSTALL], { sudo: true });
    if (installed.code !== 0) throw new Error(`Docker could not be installed in the sandbox (exit ${installed.code ?? "signal"}).\n${tail(`${installed.stdout.toString("utf8")}${installed.stderr}`)}`);
  }
  const group = await sandbox.exec("id", ["-gn"]);
  if (group.code !== 0) throw new Error(`Could not tell the sandbox user's group for Docker. ${group.stderr.trim()}`.trim());
  const state = path.posix.join(sandbox.root, ".openorc");
  const log = path.posix.join(state, "docker.log");
  await sandbox.launch("sh", ["-c", START, "dockerd", path.posix.join(state, "docker"), group.stdout.toString("utf8").trim(), log], { sudo: true });
  const deadline = Date.now() + wait.timeoutMs;
  while (!(await answers(sandbox))) {
    if (Date.now() > deadline) {
      const logged = await sandbox.exec("tail", ["-n", String(LOG_LINES), log]).catch(() => null);
      throw new Error(`Docker did not start in the sandbox.\n${tail(logged?.stdout.toString("utf8") ?? "")}`.trim());
    }
    await sleep(wait.pollMs);
  }
}
