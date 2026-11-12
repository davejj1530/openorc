import { createHash } from "node:crypto";
import type { Distro } from "./distro";

/**
 * What the core needs inside a distribution before it can start, kept in one folder of the user's home there: a Node
 * of its own, the core this app carries, and the profile it keeps. The distribution's own Node, if it has one, is
 * whatever version the user's projects need, so the core never borrows it.
 *
 *   ~/.openorc-wsl/node/<version>/bin/node
 *   ~/.openorc-wsl/app/<version>/core.mjs
 *   ~/.openorc-wsl/brain/                    the cloud brain this app installs, for Settings > Cloud
 *   ~/.openorc-wsl/data/                     the profile: the ledger, attachments and managed workspaces
 */

/** The Node the core runs under, from nodejs.org, checked against the hash its release published. */
export const WSL_NODE: NodeRelease = {
  version: "24.22.2",
  url: "https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-x64.tar.gz",
  sha256: "361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9",
};

export interface NodeRelease {
  version: string;
  url: string;
  sha256: string;
}

/** The oldest glibc Node 24 and the core's native modules load against. */
const GLIBC = [2, 28] as const;
const FOLDER = ".openorc-wsl";
const VERSION = /^[A-Za-z0-9._-]{1,64}$/;

export interface WslRuntime {
  /** What starts the core inside the distribution, given to it as it stands. */
  command: string[];
  /** Where the core keeps its profile, as the distribution names it. */
  dataDir: string;
}

/** A file this app carries for the distribution, read only when it has to be installed. */
export interface CarriedFile {
  name: string;
  read(): Promise<Buffer>;
}

export interface RuntimeSource {
  /** The core's archive, named by what it holds. */
  core: { version: string; read(): Promise<Buffer> };
  /** The cloud brain's archive and its door, copied beside the core for Settings > Cloud; none when the app carries none. */
  brain: CarriedFile[];
  /** Node's archive for Linux, whole. */
  fetchNode(url: string): Promise<Buffer>;
}

/** Why a distribution cannot run the core, in words for the person who chose it. */
export class WslSetupError extends Error {}

const MARK = "@@openorc@@";
/** The script's place, from the home folder every command main runs in the distribution starts in. */
const SETUP = `${FOLDER}/setup.sh`;

/**
 * Everything main does inside a distribution, as one script it runs by step. The script reaches the distribution on
 * the input of `tee`, and each step is started with plain words for arguments, a step's name and a version, so
 * nothing main says depends on how a command line survives the trip through wsl.exe.
 *
 *   probe <node> <core>     what is there, each value behind a marker so nothing else printed is read as one
 *   unpack <folder> <strip> the archive on the input, into a folder beside the one named and then swapped in, so a
 *                           folder that exists is always a whole one; older versions beside it go
 *   place <name> <keep>     a file of the cloud brain, from the input; the first one clears the folder
 *   start <node> <core>     the core: its frames leave on descriptor 3, where its output was, and its output joins
 *                           its errors
 */
export const SETUP_SCRIPT = [
  `root="\${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}/${FOLDER}"`,
  `case "$1" in`,
  `probe)`,
  `  printf '\\n${MARK}home=%s\\n' "\${root%/${FOLDER}}"`,
  `  printf '${MARK}machine=%s\\n' "$(uname -m)"`,
  `  printf '${MARK}glibc=%s\\n' "$(getconf GNU_LIBC_VERSION 2>/dev/null)"`,
  `  printf '${MARK}tar=%s\\n' "$(command -v tar 2>/dev/null)"`,
  `  printf '${MARK}node=%s\\n' "$("$root/node/$2/bin/node" --version 2>/dev/null)"`,
  `  test -f "$root/app/$3/manifest.json" && printf '${MARK}core=yes\\n'`,
  `  printf '${MARK}brain=%s\\n' "$(ls "$root/brain" 2>/dev/null | tr '\\n' ' ')"`,
  `  exit 0`,
  `  ;;`,
  `unpack)`,
  `  set -e`,
  `  dest="$root/$2"`,
  `  rm -rf "$dest.partial"`,
  `  mkdir -p "$dest.partial"`,
  `  tar -xzf - -C "$dest.partial" --strip-components="$3"`,
  `  rm -rf "$dest"`,
  `  mv "$dest.partial" "$dest"`,
  `  for other in "$(dirname "$dest")"/*; do test "$other" = "$dest" || rm -rf "$other"; done`,
  `  ;;`,
  `place)`,
  `  set -e`,
  `  test "$3" = keep || rm -rf "$root/brain"`,
  `  mkdir -p "$root/brain"`,
  `  cat > "$root/brain/$2.partial"`,
  `  mv "$root/brain/$2.partial" "$root/brain/$2"`,
  `  ;;`,
  `start)`,
  `  exec "$root/node/$2/bin/node" "$root/app/$3/core.mjs" 3>&1 1>&2`,
  `  ;;`,
  `*)`,
  `  exit 64`,
  `  ;;`,
  `esac`,
  ``,
].join("\n");

export interface Probe {
  home: string;
  machine: string;
  glibc: string;
  tar: boolean;
  node: string;
  core: boolean;
  brain: string[];
}

export function parseProbe(stdout: string): Probe | null {
  const values = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(MARK)) continue;
    const eq = line.indexOf("=");
    values.set(line.slice(MARK.length, eq), line.slice(eq + 1).trim());
  }
  const home = values.get("home") ?? "";
  if (!home.startsWith("/")) return null;
  return {
    home,
    machine: values.get("machine") ?? "",
    glibc: values.get("glibc") ?? "",
    tar: Boolean(values.get("tar")),
    node: values.get("node") ?? "",
    core: values.get("core") === "yes",
    brain: (values.get("brain") ?? "").split(" ").filter(Boolean),
  };
}

/** Why this distribution cannot run the core, or null when it can. */
export function unsupported(probe: Probe, distro: string): string | null {
  if (probe.machine !== "x86_64") return `${distro} runs on ${probe.machine || "an unknown processor"}, and OpenOrc's core for WSL is built for x64.`;
  const [major = 0, minor = 0] = (/(\d+)\.(\d+)/.exec(probe.glibc) ?? []).slice(1).map(Number);
  if (!probe.glibc) return `${distro} has no glibc, which OpenOrc's core needs. Use a distribution such as Ubuntu, Debian or Fedora.`;
  if (major < GLIBC[0] || (major === GLIBC[0] && minor < GLIBC[1]))
    return `${distro} has ${probe.glibc}, and OpenOrc's core needs glibc ${GLIBC.join(".")} or newer. Use a newer release of the distribution.`;
  if (!probe.tar) return `${distro} has no tar, which OpenOrc uses to install its core there. Install tar in the distribution and try again.`;
  return null;
}

/** The last thing a failed command said, as the reason. */
const failed = (what: string, said: string) => new WslSetupError(`${what}${said.trim() ? `: ${said.trim().split("\n").at(-1)}` : "."}`);

const step = (distro: Distro, name: string, args: string[], options: { input?: Buffer; timeoutMs: number }) => distro.run(["/bin/sh", SETUP, name, ...args], options);

/** Puts the script in the distribution's home, as it is for this version of the app. Also the first sign the distribution starts at all. */
async function placeScript(distro: Distro): Promise<void> {
  const unreachable = `${distro.name} did not answer. Check that it starts with "wsl -d ${distro.name}"`;
  const made = await distro.run(["mkdir", "-p", FOLDER], { timeoutMs: 60_000 });
  if (made.code !== 0) throw failed(unreachable, made.stderr || made.stdout.toString("utf8"));
  const written = await distro.run(["tee", SETUP], { input: Buffer.from(SETUP_SCRIPT), timeoutMs: 60_000 });
  if (written.code !== 0) throw failed(unreachable, written.stderr);
}

async function probe(distro: Distro, nodeVersion: string, coreVersion: string): Promise<Probe> {
  const result = await step(distro, "probe", [nodeVersion, coreVersion], { timeoutMs: 60_000 });
  const parsed = result.code === 0 ? parseProbe(result.stdout.toString("utf8")) : null;
  if (!parsed) throw failed(`${distro.name} did not say what it has`, result.stderr);
  return parsed;
}

async function unpack(distro: Distro, archive: Buffer, folder: string, strip: number, what: string): Promise<void> {
  const result = await step(distro, "unpack", [folder, String(strip)], { input: archive, timeoutMs: 10 * 60_000 });
  if (result.code !== 0) throw failed(`${what} could not be installed in ${distro.name}`, result.stderr);
}

async function installNode(distro: Distro, source: RuntimeSource, node: NodeRelease): Promise<void> {
  let archive: Buffer;
  try {
    archive = await source.fetchNode(node.url);
  } catch (error) {
    throw new WslSetupError(`Node could not be downloaded from nodejs.org: ${error instanceof Error ? error.message : String(error)}. Check the connection and try again.`);
  }
  if (createHash("sha256").update(archive).digest("hex") !== node.sha256)
    throw new WslSetupError("The Node downloaded from nodejs.org is not the one this version of OpenOrc expects, so it was not installed.");
  // Node's archive holds one folder named for its version.
  await unpack(distro, archive, `node/${node.version}`, 1, "Node");
}

async function copyBrain(distro: Distro, files: CarriedFile[]): Promise<void> {
  for (const [index, file] of files.entries()) {
    const result = await step(distro, "place", [file.name, index === 0 ? "clear" : "keep"], { input: await file.read(), timeoutMs: 5 * 60_000 });
    if (result.code !== 0) throw failed(`The cloud brain could not be copied into ${distro.name}`, result.stderr);
  }
}

/**
 * Makes the distribution ready to start this app's core and says how to start it. What is there already is left
 * alone, so every start after the first only asks. `progress` hears each slow step before it begins.
 */
export async function ensureRuntime(distro: Distro, source: RuntimeSource, progress: (text: string) => void = () => undefined, node: NodeRelease = WSL_NODE): Promise<WslRuntime> {
  if (!VERSION.test(source.core.version) || !VERSION.test(node.version)) throw new WslSetupError("This build of OpenOrc carries no core for WSL.");
  progress(`Starting ${distro.name}…`);
  await placeScript(distro);
  const found = await probe(distro, node.version, source.core.version);
  const reason = unsupported(found, distro.name);
  if (reason) throw new WslSetupError(reason);
  const hasNode = found.node === `v${node.version}`;
  if (!hasNode) {
    progress(`Setting up OpenOrc in ${distro.name}: downloading Node ${node.version}…`);
    await installNode(distro, source, node);
  }
  if (!found.core) {
    progress(`Setting up OpenOrc in ${distro.name}: installing its core…`);
    await unpack(distro, await source.core.read(), `app/${source.core.version}`, 0, "OpenOrc's core");
  }
  const brain = source.brain.filter((file) => VERSION.test(file.name));
  if (
    brain.length &&
    brain
      .map((file) => file.name)
      .sort()
      .join() !== [...found.brain].sort().join()
  )
    await copyBrain(distro, brain);
  if (!hasNode || !found.core) {
    const check = await probe(distro, node.version, source.core.version);
    if (check.node !== `v${node.version}` || !check.core) throw new WslSetupError(`OpenOrc's core did not install in ${distro.name}. Check the free space in the distribution and try again.`);
  }
  return { command: ["/bin/sh", SETUP, "start", node.version, source.core.version], dataDir: `${found.home}/${FOLDER}/data` };
}
