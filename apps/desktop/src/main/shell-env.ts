/**
 * What the user's login shell knows that a Dock-launched app does not.
 *
 * The core asks the shell, because the core is what launches agents and Ready
 * has to mean launchable there. Main only hosts the Terminal panels, so it
 * keeps a copy of every snapshot the core accepts and hands the PATH to each
 * shell a panel spawns. A Rescan in the app reaches here a moment after the
 * core has adopted it; a panel opened inside that moment inherits the previous
 * PATH, which is a documented limit rather than a guarantee.
 *
 * Snapshots arrive with the core's revision, and each core process main
 * starts gets its own generation here. A message is accepted only when it is
 * newer than the last accepted one within its generation, or when it comes
 * from a newer generation. So a restarted core's revision 1 wins, and a late
 * message from the core it replaced cannot.
 */
export interface ShellEnv {
  path: string;
  claude: string | null;
  codex: string | null;
}

export interface ShellEnvMessage {
  revision: number;
  env: ShellEnv;
}

/** The narrow surface of a UtilityProcess this module needs. Electron delivers the raw payload, not a MessageEvent. */
export interface CoreMessages {
  on(event: "message", listener: (payload: unknown) => void): unknown;
}

const FIRST_SNAPSHOT_WAIT_MS = 10_000;

let current: ShellEnv | null = null;
let accepted: { generation: number; revision: number } | null = null;
let generations = 0;
let waiters: Array<(env: ShellEnv | null) => void> = [];

/** The core's message, checked rather than trusted: the utility process is ours, but the shape is still a contract. */
export function shellEnvFromMessage(data: unknown): ShellEnvMessage | null {
  if (typeof data !== "object" || data === null || (data as { type?: unknown }).type !== "shell-env") return null;
  const snapshot = (data as { snapshot?: unknown }).snapshot;
  if (typeof snapshot !== "object" || snapshot === null) return null;
  const { revision, path, binaries } = snapshot as { revision?: unknown; path?: unknown; binaries?: unknown };
  if (!Number.isInteger(revision) || typeof path !== "string" || typeof binaries !== "object" || binaries === null) return null;
  const { claude, codex } = binaries as { claude?: unknown; codex?: unknown };
  return { revision: revision as number, env: { path, claude: typeof claude === "string" ? claude : null, codex: typeof codex === "string" ? codex : null } };
}

/** Accepts a snapshot when it is newer than the last one from its generation, or from a newer generation. Returns whether it was. */
export function acceptShellEnv(generation: number, message: ShellEnvMessage): boolean {
  if (accepted && generation < accepted.generation) return false;
  if (accepted && generation === accepted.generation && message.revision <= accepted.revision) return false;
  accepted = { generation, revision: message.revision };
  current = message.env;
  const waiting = waiters;
  waiters = [];
  for (const resolve of waiting) resolve(message.env);
  return true;
}

/**
 * Binds a freshly started core to the store. Each call is a new generation,
 * so the order cores were started in decides which one's snapshots win.
 */
export function listenForShellEnv(core: CoreMessages): number {
  const generation = ++generations;
  core.on("message", (payload) => {
    const message = shellEnvFromMessage(payload);
    if (message) acceptShellEnv(generation, message);
  });
  return generation;
}

/**
 * The latest accepted snapshot. A panel opened before the core's first answer
 * waits for it rather than spawning with the launcher's bare PATH, but not
 * forever: a core that never answers should still leave the user a terminal.
 */
export function loginShellEnv(waitMs = FIRST_SNAPSHOT_WAIT_MS): Promise<ShellEnv | null> {
  if (current) return Promise.resolve(current);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters = waiters.filter((w) => w !== settle);
      resolve(null);
    }, waitMs);
    const settle = (env: ShellEnv | null) => {
      clearTimeout(timer);
      resolve(env);
    };
    waiters.push(settle);
  });
}

/** Forgets every snapshot and generation, so each test starts before any core has spoken. */
export function resetShellEnvForTests(): void {
  current = null;
  accepted = null;
  generations = 0;
  waiters = [];
}
