/** Types shared by preload and renderer. Pure types, no runtime. */

export interface ProcessMetric {
  pid: number;
  type: string;
  name: string;
  workingSetKb: number;
  privateKb: number;
  cpuPercent: number;
}

export interface AppMetrics {
  coldStartMs: number | null;
  processes: ProcessMetric[];
}

export interface Autorun {
  /** Start the bridge bench on connect and report when done. */
  bench: boolean;
  /** Seed a large thread, open it, stream into it and into unrelated runs, report frame costs, and finish. */
  threadBench: boolean;
  /** Start a Codex run on connect, auto-approve, report when done. */
  codex: boolean;
  thread: boolean;
  model: string | null;
  image: string | null;
  cwd: string | null;
  prompt: string | null;
  /** The harness named for the smoke run, unvalidated; the renderer falls back to the default harness. */
  agent: string | null;
  /** Render the synthetic 10k-line diff, measure first paint and scroll, report. */
  diff: boolean;
  diffMode: DiffMode;
  /** Open a screen on launch, for screenshots and second windows: "inbox", "tasks", "settings", "task:<id>:<tab>", "project:<id>", "thread:<id>". */
  route: string | null;
  /** Force a theme on launch, for screenshots. */
  theme: "light" | "dark" | null;
}

/** How the diff viewer highlights: on the main thread, in a worker pool, or not at all. */
export type DiffMode = "main" | "worker" | "plain";

/** A rectangle in window coordinates, as the renderer measures it with getBoundingClientRect. */
export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * An interactive shell, hosted in the main process rather than the core.
 *
 * Main owns it for three reasons that are all properties of the core, not
 * preferences: every event the core emits is written to the ledger, so a shell
 * session would be persisted keystroke by keystroke; the bridge's frame buffer
 * is unbounded, so a noisy command would grow memory without limit; and the
 * core's protocol is request/response, with no shape for bytes nobody asked
 * for. A separate channel avoids all three instead of making exceptions to
 * them.
 *
 * `id` is the surface that owns the shell, so a shell outlives the panel that
 * shows it. Closing the panel unmounts the view; only `kill` ends the process.
 */
export interface TerminalApi {
  /**
   * Say a viewer is watching `id`. Main posts output only while something is,
   * so a shell in a tab nobody has open fills its scrollback in silence rather
   * than pushing to a window that will throw every chunk away.
   *
   * Called BEFORE open, so bytes written during the round trip land in the
   * snapshot that open returns instead of falling between the two.
   */
  attach(id: string): void;
  /** Stop watching. The shell keeps running; only `kill` ends it. */
  detach(id: string): void;
  /**
   * Start a shell for `id`, or re-attach to the running one. Resolves the
   * scrollback to replay, and for a shell that already ended, the code it
   * ended with: nobody was listening when it exited, so the push went nowhere.
   */
  open(input: { id: string; cwd: string; cols: number; rows: number }): Promise<{ backlog: string; running: boolean; exitCode: number | null }>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  /** End the shell and forget its scrollback. Hiding the panel must not call this. */
  kill(id: string): void;
  /** Output for one shell. Returns the unsubscribe. */
  onData(id: string, cb: (chunk: string) => void): () => void;
  onExit(id: string, cb: (code: number | null) => void): () => void;
  /** A command the user typed into any shell has finished, as far as its output shows. Files it wrote may be new. */
  onSettled(cb: (id: string) => void): () => void;
}

export interface BrowserPaneState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  /** Set when a load failed, so the pane can say so rather than showing a blank rectangle. */
  error: string | null;
}

/**
 * A web view in the panel, composited by the OS above the page rather than
 * inside it. That is the whole reason this is an API and not a component: the
 * renderer must tell main where to paint it, and must hide it explicitly,
 * because the view honours neither the panel's `inert` state nor its clip.
 *
 * Opens local and public HTTP(S) websites in a sandboxed session separate
 * from the app and its privileged openorc-asset scheme.
 */
export interface BrowserPaneApi {
  /** Register the panel's current conversation, including when Preview is hidden. */
  setContext(id: string | null): void;
  onReveal(cb: (id: string) => void): () => void;
  /** Create or reveal the view for `id`, painted at `bounds`, loading `url` when given. */
  show(input: { id: string; bounds: PaneRect; url?: string }): Promise<BrowserPaneState>;
  /** Move the view without reloading it. Called on every panel resize and scroll. */
  setBounds(id: string, bounds: PaneRect): void;
  /** Detach from the screen, keeping the page alive. */
  hide(id: string): void;
  /** The page as it is on screen, as an image data URL. Null while the view is off screen. */
  capture(id: string): Promise<string | null>;
  navigate(id: string, url: string): void;
  goBack(id: string): void;
  goForward(id: string): void;
  reload(id: string): void;
  /** Destroy the view and its page. */
  close(id: string): void;
  onState(id: string, cb: (state: BrowserPaneState) => void): () => void;
}

/** Main owns the update preference: the updater runs with no window open. */
export interface UpdateSettings {
  /** Whether OpenOrc checks for a new release shortly after launch and every six hours. */
  automaticChecks: boolean;
  /** Why this build cannot update, such as a development build; null for an installed release. */
  unavailable: string | null;
}

export interface WindowAppearance {
  theme: "system" | "light" | "dark";
  transparent: boolean;
  background: string;
}

export interface WindowAppearanceResult {
  supported: boolean;
  enabled: boolean;
  reducedTransparency: boolean;
}

export interface OpenOrcApi {
  projectIcons: import("./project-icons").ProjectIconsApi;
  mcpApps: {
    register(document: import("@openorc/protocol").McpAppDocument): Promise<{ id: string; url: string }>;
    release(id: string): void;
  };
  connectBridge(): void;
  metrics(): Promise<AppMetrics>;
  /** Hand a measurement to the main process log (and quit when autorun asks). */
  report(payload: unknown): void;
  /** Native folder picker. Resolves null when cancelled. */
  pickDirectory(): Promise<string | null>;
  /** Recover the local path selected by a renderer file input. */
  filePath(file: File): string;
  openExternal(url: string): void;
  revealFile(path: string): void;
  /** A second window on a route spec such as "thread:<id>". */
  openWindow(route: string): void;
  isFullscreen(): Promise<boolean>;
  /** Align native window chrome with the current Chromium zoom; returns its factor. */
  syncWindowChrome(): Promise<number>;
  syncWindowAppearance(appearance: WindowAppearance): Promise<WindowAppearanceResult>;
  /** Fires on every enter and leave of fullscreen; returns the unsubscribe. */
  onFullscreen(cb: (fullscreen: boolean) => void): () => void;
  platform: string;
  updates: {
    settings(): Promise<UpdateSettings>;
    setAutomaticChecks(on: boolean): Promise<UpdateSettings>;
    getState(): Promise<import("./app-updates").UpdateSnapshot>;
    onState(callback: (snapshot: import("./app-updates").UpdateSnapshot) => void): () => void;
    dismiss(request: import("./app-updates").UpdateDismissal): Promise<import("./app-updates").UpdateSnapshot>;
    download(): Promise<void>;
    install(): Promise<void>;
  };
  autorun: Autorun;
  terminal: TerminalApi;
  browser: BrowserPaneApi;
}
