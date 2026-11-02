import path from "node:path";

/** The port the brain's sandbox declares and its phone listener binds; phones dial the proxy's 443. */
export const BRAIN_PORT = 47_820;
/** The brain and its thread sandboxes live here, apart from the Mac's openorc-sandboxes, so each host lists only its own. */
export const BRAIN_PROJECT = "openorc-brain";
/** Outside SANDBOX_PREFIX, so no list of thread sandboxes ever offers the brain for removal. */
export const BRAIN_SANDBOX = "brain";
/** The session timeout the brain is made and resumed with: a brain that stops extending it sleeps within this. */
export const BRAIN_AWAY_MS = 10 * 60_000;
/** The line `serve` prints on stdout, followed by a space and its version, once phones and `ctl` can reach it. */
export const BRAIN_READY = "openorc-brain ready";
/** How `serve` and `ctl` end when they do not succeed, after sysexits.h. */
export const BRAIN_EXIT = {
  /** The line on stdin was missing or did not parse. */
  badStart: 64,
  /** `ctl` found no brain answering. */
  unavailable: 69,
  /** Another `serve` holds the lock. */
  alreadyRunning: 75,
  /** The key does not open this brain's secrets. */
  wrongKey: 77,
  /** No bundle is installed, or the machine lacks what the brain needs. */
  needsProvision: 78,
} as const;

/** Every path on the brain's disk. The provisioner and the host both derive it from the same root. */
export interface BrainLayout {
  root: string;
  /** Installed versions, one folder each, and `current`. */
  apps: string;
  app(version: string): string;
  /** Symlink to the version the next start runs. */
  current: string;
  /** The entry points of the version `current` names. */
  serve: string;
  ctl: string;
  /** The core's data folder. */
  data: string;
  /** Sealed secret files, one per channel, and the key check. */
  secrets: string;
  run: string;
  /** Held by the running brain, so a second start exits with `alreadyRunning`. */
  lock: string;
  /** Where `ctl` reaches the running brain. */
  socket: string;
  logs: string;
  log: string;
  /** npm's global prefix for the brain's own agent CLIs, owned by the default user. */
  npm: string;
  /** Uploads waiting to be installed or imported. */
  inbox: string;
  /** Every folder machine setup makes, under a root only the default user can open. */
  folders: string[];
}

/** The root is `<sandbox cwd>/openorc-brain`; the host finds it two folders above the real path of its own entry. */
export function brainLayout(root: string): BrainLayout {
  const at = (...parts: string[]) => path.posix.join(root, ...parts);
  const apps = at("app");
  const current = path.posix.join(apps, "current");
  const layout = {
    root,
    apps,
    app: (version: string) => path.posix.join(apps, version),
    current,
    serve: path.posix.join(current, "brain.mjs"),
    ctl: path.posix.join(current, "ctl.mjs"),
    data: at("data"),
    secrets: at("data", "secrets"),
    run: at("run"),
    lock: at("run", "brain.lock"),
    socket: at("run", "brain.sock"),
    logs: at("logs"),
    log: at("logs", "brain.log"),
    npm: at("npm"),
    inbox: at("inbox"),
  };
  return { ...layout, folders: [layout.apps, layout.data, layout.run, layout.logs, layout.npm, layout.inbox] };
}
