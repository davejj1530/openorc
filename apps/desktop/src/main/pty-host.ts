import { statSync } from "node:fs";
import os from "node:os";
import { isAbsolute } from "node:path";
import { COMMAND_SETTLE_MS, commandSettleWatcher, type CommandSettleWatcher } from "../shared/command-settle";
import { loginShellEnv } from "./shell-env";

/**
 * The shells behind the Terminal panel. Main hosts them for the reasons
 * TerminalApi states, and this file is where the properties that keep a shell
 * cheap live: a bounded ring instead of an unbounded transcript, one message
 * per frame instead of one per read, nothing sent at all while no panel is
 * watching, and a map that outlives every panel that ever showed it.
 */

/** node-pty's IDisposable, under the name the handlers it hands back are kept by. */
export interface PtyListener {
  dispose(): void;
}

/**
 * What the host needs from node-pty, which is also the seam the tests spawn
 * nothing through. node-pty's IPty satisfies it structurally, so nothing has
 * to adapt at the call site.
 */
export interface PtyProcess {
  onData(cb: (data: string) => void): PtyListener;
  onExit(cb: (event: { exitCode: number }) => void): PtyListener;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export type SpawnPty = (input: { cwd: string; cols: number; rows: number }) => Promise<PtyProcess>;

/** Where coalesced output goes. Separate from the host so the tests can read it and installPtyHost can aim it at a window. */
export interface PtySink {
  data(id: string, chunk: string): void;
  exit(id: string, code: number | null): void;
  /** A command typed into `id` has finished, as far as its output shows. Reported whether or not anyone is watching. */
  settled(id: string): void;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface OpenInput extends TerminalSize {
  id: string;
  cwd: string;
}

/**
 * What a panel needs to draw a shell it may never have seen. The exit code is
 * part of it because a viewer that was away while the shell ended has no other
 * way to learn how it ended: nothing was posted to it at the time.
 */
export interface TerminalAttachment {
  backlog: string;
  running: boolean;
  exitCode: number | null;
}

/**
 * 256 KiB of replay, on the order of three thousand lines of an eighty-column
 * shell: about what a terminal keeps by default, so re-attaching redraws the
 * history the reader could have scrolled to and nothing beyond it. The cap is
 * what makes `yes` survivable. The ring drops from the front, so a command
 * that never stops costs this much once and then stops costing.
 */
const SCROLLBACK_BYTES = 256 * 1024;

/**
 * One animation frame, the budget the core's FrameCoalescer already spends on
 * agent output. A shell can write thousands of times a second; batching by
 * time rather than by chunk holds the renderer to sixty messages a second
 * whatever it writes, and still echoes a keystroke inside the same frame.
 * Size is deliberately not a second trigger: the ring caps what can pile up in
 * one window, so an early flush would add messages without removing bytes.
 */
const FLUSH_MS = 16;

/** Guards against the fractional or zero geometry node-pty rejects and a hidden panel measures. */
export function clampSize(cols: number, rows: number): TerminalSize {
  const whole = (value: number, fallback: number): number => (Number.isFinite(value) ? Math.min(1000, Math.max(1, Math.trunc(value))) : fallback);
  return { cols: whole(cols, 80), rows: whole(rows, 24) };
}

/**
 * A shell inherits its directory once and keeps it for life, so a wrong one is
 * not something the panel can recover from. Each refusal says which of the
 * three things was wrong, because "could not start" reads the same for a typo
 * and for a worktree that was removed underneath the thread.
 */
export function validateCwd(cwd: string): string {
  if (cwd.length === 0 || cwd.includes("\0")) throw new Error("A terminal needs a directory to start in.");
  if (!isAbsolute(cwd)) throw new Error(`A terminal needs an absolute directory, and ${cwd} is relative.`);
  const stat = statSync(cwd, { throwIfNoEntry: false });
  if (!stat) throw new Error(`${cwd} no longer exists, so no shell can start there.`);
  if (!stat.isDirectory()) throw new Error(`${cwd} is a file, not a directory.`);
  return cwd;
}

/** The last `cap` bytes, minus the continuation bytes of the codepoint the cut landed inside. */
function tail(text: string, cap: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= cap) return text;
  let start = bytes.length - cap;
  while (start < bytes.length && ((bytes[start] ?? 0) & 0b1100_0000) === 0b1000_0000) start += 1;
  return bytes.subarray(start).toString("utf8");
}

/** SGR 0, written out so no source line in this file carries a raw escape byte. */
const RESET = `${String.fromCharCode(27)}[0m`;

/**
 * Drop-oldest scrollback under a hard byte cap. Chunks stay whole while they
 * fit, because that is the cheapest thing that bounds memory; only the
 * degenerate case of one chunk larger than the entire cap is cut inside.
 */
export class Scrollback {
  private readonly chunks: string[] = [];
  private bytes = 0;
  private dropped = false;

  constructor(private readonly cap = SCROLLBACK_BYTES) {}

  push(chunk: string): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.bytes += Buffer.byteLength(chunk, "utf8");
    while (this.bytes > this.cap && this.chunks.length > 1) {
      const oldest = this.chunks.shift();
      if (oldest === undefined) break;
      this.bytes -= Buffer.byteLength(oldest, "utf8");
      this.dropped = true;
    }
    const only = this.chunks[0];
    if (only !== undefined && this.chunks.length === 1 && this.bytes > this.cap) {
      const cut = tail(only, this.cap);
      this.chunks[0] = cut;
      this.bytes = Buffer.byteLength(cut, "utf8");
      this.dropped = true;
    }
  }

  /**
   * The replay. A drop cuts the stream mid-sequence, so whatever colour or
   * mode the lost bytes turned on is still notionally in effect; the reset
   * keeps that from bleeding over the first screen the reader sees.
   */
  read(): string {
    const text = this.chunks.join("");
    return this.dropped ? `${RESET}${text}` : text;
  }

  get byteLength(): number {
    return this.bytes;
  }
}

interface Session {
  readonly pty: PtyProcess;
  readonly scrollback: Scrollback;
  /** onData and onExit. A shell that ignores SIGHUP outlives the kill, so the host lets go of it explicitly. */
  readonly listeners: PtyListener[];
  /** Only ever filled while a viewer is attached, which is what keeps an unwatched shell from batching for the life of the app. */
  pending: string;
  timer: NodeJS.Timeout | null;
  exited: boolean;
  exitCode: number | null;
  readonly commands: CommandSettleWatcher;
}

/**
 * A spawn that has not returned yet, and the two things that can happen to a
 * shell before it exists. React runs a panel's effects twice in development,
 * so two opens for one id arrive before the first spawn resolves; without this
 * the second starts a shell nothing will ever kill. Restart is why the other
 * two fields are here: it kills and re-opens inside the same window, and a
 * panel measures itself there too.
 */
interface Start {
  readonly session: Promise<Session | null>;
  cancelled: boolean;
  /** A resize that arrived with no pty to take it. Applied once there is one. */
  size: TerminalSize | null;
}

/**
 * The shells, keyed by the surface that opened them. Nothing here is tied to a
 * panel: attaching says where output should go for now, detaching says nobody
 * is watching, and only kill ends a process and forgets what it said.
 */
export class PtyHost {
  private readonly sessions = new Map<string, Session>();
  private readonly starting = new Map<string, Start>();
  /** The ids a viewer is watching. Output for anything else stays in its ring until someone comes back for it. */
  private readonly attached = new Set<string>();

  constructor(
    private readonly spawn: SpawnPty,
    private readonly sink: PtySink,
    private readonly flushMs = FLUSH_MS,
    private readonly settleMs = COMMAND_SETTLE_MS,
  ) {}

  private updating = false;

  /** Reserve an idle host synchronously so a new shell cannot slip into the update handoff. */
  prepareForUpdate(): boolean {
    if (this.starting.size || [...this.sessions.values()].some((session) => !session.exited)) return false;
    this.updating = true;
    return true;
  }

  cancelUpdate(): void {
    this.updating = false;
  }

  async open(input: OpenInput): Promise<TerminalAttachment> {
    if (this.updating) throw new Error("OpenOrc is restarting to update. Please wait.");
    const size = clampSize(input.cols, input.rows);
    const live = this.sessions.get(input.id);
    if (live) {
      // The shell is where it is and may have cd'd since, so a re-attach
      // adopts it rather than arguing about the cwd the caller asked for.
      if (!live.exited) live.pty.resize(size.cols, size.rows);
      return this.replay(live);
    }
    // Checked before the lookup: as the right-hand side of a `??` this is
    // skipped on the branch that joins an in-flight start, which is exactly
    // where a directory that went away between two opens shows up.
    const cwd = validateCwd(input.cwd);
    const start = this.starting.get(input.id) ?? this.begin(input.id, cwd, size);
    const session = await start.session;
    // Killed before it ever ran. Nothing was installed, so there is nothing to
    // replay and nothing to draw beyond saying so.
    if (!session) return { backlog: "", running: false, exitCode: null };
    return this.replay(session);
  }

  /** Output for `id` goes to the sink from here until the viewer detaches. */
  attach(id: string): void {
    this.attached.add(id);
  }

  /**
   * Nobody is watching. The shell keeps running and keeps filling its ring,
   * which is what the next open replays; what stops is the traffic.
   */
  detach(id: string): void {
    this.attached.delete(id);
    const session = this.sessions.get(id);
    if (!session) return;
    this.stopTimer(session);
    session.pending = "";
  }

  /**
   * Every viewer at once, for a renderer that went away without saying so. A
   * reload tears the page down with no React cleanup, so the detach a closing
   * panel would have sent never arrives and main keeps posting to a page that
   * no longer has anything listening. The shells themselves are untouched.
   */
  detachAll(): void {
    for (const id of [...this.attached]) this.detach(id);
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session || session.exited) return;
    session.commands.input(data);
    session.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const size = clampSize(cols, rows);
    const start = this.starting.get(id);
    if (start) start.size = size;
    const session = this.sessions.get(id);
    if (!session || session.exited) return;
    session.pty.resize(size.cols, size.rows);
  }

  /**
   * Ends the shell and forgets it. Dropping the entry is what forgets the
   * scrollback, and what makes the next open a fresh start rather than a
   * resurrection of a dead one.
   */
  kill(id: string): void {
    const start = this.starting.get(id);
    if (start) {
      // There is no pty to kill yet, so the spawn has to do it on arrival.
      // Dropping the entry as well is what lets the open that Restart fires
      // immediately afterwards begin a shell of its own.
      start.cancelled = true;
      this.starting.delete(id);
    }
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    this.stopTimer(session);
    session.commands.dispose();
    for (const listener of session.listeners) listener.dispose();
    if (!session.exited) session.pty.kill();
  }

  killAll(): void {
    for (const id of new Set([...this.starting.keys(), ...this.sessions.keys()])) this.kill(id);
  }

  private begin(id: string, cwd: string, size: TerminalSize): Start {
    const start: Start = {
      cancelled: false,
      size: null,
      // `start` is read only once the spawn settles, by which point this
      // assignment has run.
      session: this.spawn({ cwd, ...size }).then(
        (pty) => this.adopt(id, pty, start),
        (error: unknown) => {
          this.forget(id, start);
          throw error;
        },
      ),
    };
    this.starting.set(id, start);
    return start;
  }

  /** Installs a spawned pty under `id`, unless a kill reached the id first. */
  private adopt(id: string, pty: PtyProcess, start: Start): Session | null {
    this.forget(id, start);
    if (start.cancelled) {
      // The kill landed with nothing to kill. This is the first moment there
      // is something; installing it instead would leave a shell running that
      // no panel will ever show and no kill will ever reach.
      pty.kill();
      return null;
    }
    const session: Session = {
      pty,
      scrollback: new Scrollback(),
      pending: "",
      timer: null,
      exited: false,
      exitCode: null,
      listeners: [],
      commands: commandSettleWatcher(() => this.sink.settled(id), this.settleMs),
    };
    this.sessions.set(id, session);
    // Both handlers check that this session still holds the key. A kill lets
    // go of them, but a pty can be mid-emit when it does, and stale output
    // must neither print into the next shell nor mark it dead.
    session.listeners.push(
      pty.onData((chunk) => {
        if (this.sessions.get(id) !== session) return;
        session.scrollback.push(chunk);
        session.commands.output(chunk);
        if (!this.attached.has(id)) return;
        session.pending += chunk;
        session.timer ??= setTimeout(() => this.flush(id, session), this.flushMs);
      }),
      pty.onExit(({ exitCode }) => {
        if (this.sessions.get(id) !== session) return;
        session.exited = true;
        session.exitCode = exitCode;
        session.commands.dispose();
        this.flush(id, session);
        // With nobody watching there is nobody to tell: the code is held for
        // the next open, which is how a panel that was away learns of it.
        if (this.attached.has(id)) this.sink.exit(id, exitCode);
      }),
    );
    if (start.size) pty.resize(start.size.cols, start.size.rows);
    return session;
  }

  /** Drops a start, unless a kill already replaced it with a newer one for the same id. */
  private forget(id: string, start: Start): void {
    if (this.starting.get(id) === start) this.starting.delete(id);
  }

  /**
   * A scheduled batch is dropped rather than sent: those bytes are already in
   * the ring the caller is about to draw, and sending them as well would print
   * the tail of the session twice.
   */
  private replay(session: Session): TerminalAttachment {
    this.stopTimer(session);
    session.pending = "";
    return { backlog: session.scrollback.read(), running: !session.exited, exitCode: session.exitCode };
  }

  private flush(id: string, session: Session): void {
    this.stopTimer(session);
    const chunk = session.pending;
    session.pending = "";
    if (chunk.length > 0) this.sink.data(id, chunk);
  }

  private stopTimer(session: Session): void {
    if (session.timer === null) return;
    clearTimeout(session.timer);
    session.timer = null;
  }
}

/**
 * The shell the core probes, so the panel and the PATH it inherits come from one shell. The account's login shell
 * comes first: SHELL is inherited from whatever launched OpenOrc and only fills in when the account names none.
 * Past both, the same default as the core's probe: zsh on macOS, /bin/sh elsewhere.
 */
export function terminalShell(env: NodeJS.ProcessEnv = process.env, accountShell: () => string | null = currentAccountShell): string {
  if (process.platform === "win32") return env["COMSPEC"] ?? "powershell.exe";
  return accountShell() || env["SHELL"] || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
}

function currentAccountShell(): string | null {
  try {
    return os.userInfo().shell;
  } catch {
    return null;
  }
}

/**
 * This process's environment minus what a shell should not inherit. The shell
 * runs interactive but not as a login shell: shell-env has already paid for
 * the profile once, and paying again per panel would also print the profile's
 * banner into every new terminal.
 */
export function ptyEnv(base: NodeJS.ProcessEnv, path: string | null): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }
  // Set on the environment the core's utility process runs with. A shell that
  // inherits it turns every `node` the user types into Electron.
  delete env["ELECTRON_RUN_AS_NODE"];
  if (path) env["PATH"] = path;
  env["TERM"] = "xterm-256color";
  env["COLORTERM"] = "truecolor";
  env["TERM_PROGRAM"] = "OpenOrc";
  return env;
}

/**
 * node-pty carries a native binding, so it loads on first use rather than at
 * startup: a missing prebuild then fails one panel with a message the panel
 * can show, instead of the main process before a window exists.
 *
 * The PATH is the login shell's rather than this process's, so a shell the
 * user types into resolves tools in the order their terminal does. It is the
 * snapshot the core adopted for agents, not a second probe.
 */
const spawnShell: SpawnPty = async ({ cwd, cols, rows }) => {
  const { spawn } = await import("node-pty");
  const shell = await loginShellEnv();
  return spawn(terminalShell(), [], { name: "xterm-256color", cwd, cols, rows, env: ptyEnv(process.env, shell?.path ?? null) });
};

/** The renderer is the only caller and still the untrusted side of the bridge, so the payload is checked rather than trusted. */
function openInput(value: unknown): OpenInput {
  if (typeof value !== "object" || value === null) throw new Error("A terminal needs an id and a directory.");
  const id = "id" in value ? value.id : undefined;
  const cwd = "cwd" in value ? value.cwd : undefined;
  const cols = "cols" in value ? value.cols : undefined;
  const rows = "rows" in value ? value.rows : undefined;
  if (typeof id !== "string" || id.length === 0) throw new Error("A terminal needs an id.");
  if (typeof cwd !== "string") throw new Error("A terminal needs a directory to start in.");
  return { id, cwd, cols: typeof cols === "number" ? cols : 80, rows: typeof rows === "number" ? rows : 24 };
}

/** One host for the process, which is what lets a shell outlive the panel, the tab and a renderer reload. */
let host: PtyHost | null = null;

/**
 * Wires TerminalApi's main half onto ipcMain. Output is addressed to the
 * window rather than to whoever called open: a shell keeps running while
 * nothing is watching it, and the bytes it writes meanwhile are already in the
 * ring that the next open replays.
 */
export function installPtyHost(ipcMain: Electron.IpcMain, options: { getWindow: () => Electron.BrowserWindow | null; getWindows: () => Electron.BrowserWindow[] }): void {
  if (host) return;
  const send = (channel: string, id: string, payload: string | number | null): void => {
    // A shell outlives its window on purpose, so this runs with a window that
    // may already be gone. Reading webContents off a destroyed BrowserWindow
    // throws, so the window is checked before it is touched at all.
    const win = options.getWindow();
    if (!win || win.isDestroyed()) return;
    const contents = win.webContents;
    if (!contents.isDestroyed()) contents.send(channel, id, payload);
  };
  const live = new PtyHost(spawnShell, {
    data: (id, chunk) => send("terminal:data", id, chunk),
    exit: (id, code) => send("terminal:exit", id, code),
    // Any window may be showing a diff of the checkout the command changed, not only the terminal's own.
    settled: (id) => {
      for (const win of options.getWindows()) {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("terminal:settled", id, null);
      }
    },
  });
  host = live;

  ipcMain.handle("terminal:open", (_event, input: unknown) => live.open(openInput(input)));
  ipcMain.on("terminal:write", (_event, id: unknown, data: unknown) => {
    if (typeof id === "string" && typeof data === "string") live.write(id, data);
  });
  ipcMain.on("terminal:resize", (_event, id: unknown, cols: unknown, rows: unknown) => {
    if (typeof id === "string" && typeof cols === "number" && typeof rows === "number") live.resize(id, cols, rows);
  });
  ipcMain.on("terminal:kill", (_event, id: unknown) => {
    if (typeof id === "string") live.kill(id);
  });
  ipcMain.on("terminal:attach", (_event, id: unknown) => {
    if (typeof id === "string") live.attach(id);
  });
  ipcMain.on("terminal:detach", (_event, id: unknown) => {
    if (typeof id === "string") live.detach(id);
  });
}

/** A renderer that reloaded cannot detach its panels, so main drops every viewer and waits to be asked again. */
export function detachAllPtys(): void {
  host?.detachAll();
}

/**
 * Called from before-quit, alongside the core's shutdown. These are child
 * processes of this one: left alone they outlive the app as orphans still
 * holding whatever the user was running.
 */
export function killAllPtys(): void {
  host?.killAll();
}

export function preparePtysForUpdate(): boolean {
  return host?.prepareForUpdate() ?? true;
}

export function cancelPtyUpdate(): void {
  host?.cancelUpdate();
}
