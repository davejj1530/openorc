import type { HostChoice } from "../shared/host";
import type { CoreProcess } from "./host-core";
import { closeCore, closeCoreForUpdate, closeWhenIdle } from "./update-handoff";
import { WslCore } from "./wsl/core";
import { ALREADY_RUNNING } from "./wsl/runtime";

/** What the user chose about a distribution that could not run the core. */
export type DistroAnswer = "retry" | "local" | "quit";

/** What the core's life needs from the app around it: its windows, its shells, the question it asks and the preference it keeps. */
export interface CoreLifecycleDeps<Window> {
  /** Where the core runs now: the preference, as this computer can honour it. */
  host(): HostChoice;
  /** Starts a core there, with everything main installs on one. */
  start(host: HostChoice): CoreProcess;
  /** Hands the core one window. */
  connect(core: CoreProcess, window: Window): void;
  everyWindow(): Window[];
  reload(windows: Iterable<Window>): void;
  /** Ends what belongs to the place being left: its shells and its pages. */
  leave(): void;
  /** The Terminal panels' shells. `hold` stops new ones starting and says whether none is running; `release` lets them start again. */
  shells: { hold(): boolean; release(): void };
  /** Asks what to do about a distribution that could not run the core, or stopped running it. */
  ask(distro: string, reason: string): Promise<DistroAnswer>;
  /** Makes this computer the place OpenOrc runs. */
  chooseLocal(): void;
  quit(): void;
  /** Adds a folder as a project on a core that is starting. `done` hears its answer, with its reason when it refused. */
  importProject(core: CoreProcess, folder: string, done: (error?: string) => void): void;
  /** Says a folder could not be added as a project where OpenOrc now runs. */
  folderNotAdded(folder: string, reason: string): void;
}

/**
 * What main is doing with its core, one thing at a time. A window is handed a core only while it is `serving`.
 *
 *   serving    a core runs, or the next window to ask starts one
 *   switching  the core is closing so one can start somewhere else
 *   updating   the core is closing for an update, or has closed for it; only a refusal goes back to serving
 *   asking     a distribution could not run the core, and the user has not yet said what to do
 *   quitting   the app leaves once the core has closed
 */
type Phase = "serving" | "switching" | "updating" | "asking" | "quitting";

/** How long a core that was told to shut down for a quit has before it is ended. */
const QUIT_WITHIN_MS = 12_000;

/** Why a core inside a distribution stopped by itself, from how it exited and the last things it printed. */
function stopReason(distro: string, code: number, lastWords: string): string {
  if (code === ALREADY_RUNNING) return `OpenOrc is already running in ${distro}, or is still closing there. Close any other OpenOrc that runs in ${distro}, then try again.`;
  const said = lastWords ? `\n\nThe last it said:\n${lastWords}` : "";
  return `Its core there stopped (exit ${code}). The distribution may have been shut down.${said}`;
}

/**
 * The one core main holds, from its start to the app's quit: started where the preference says, closed for a switch or
 * an update, started again elsewhere, and asked about when a distribution cannot run it. Every exit is heard here, so
 * what follows one never depends on the order other listeners were added in.
 */
export class CoreLifecycle<Window> {
  private core: CoreProcess | null = null;
  private phase: Phase = "serving";
  /** Windows that asked for a core while it was closing to switch. A switch that goes through reloads every window; one that is refused reloads these, which were left without a core. */
  private readonly turnedAway = new Set<Window>();
  /** A folder chosen where OpenOrc was not running, to add as a project once a core is up where it lives. Kept until that core answers, so a start that fails and is tried again still adds it. */
  private folderToAdd: string | null = null;

  constructor(private readonly deps: CoreLifecycleDeps<Window>) {}

  /** Starts the first core. */
  begin(): void {
    this.start();
  }

  /** Hands a window the core, starting one if none runs. A window that asks while the core is closing waits for what follows. */
  connect(window: Window): void {
    if (this.phase === "switching") this.turnedAway.add(window);
    if (this.phase !== "serving") return;
    this.deps.connect(this.core ?? this.start(), window);
  }

  /**
   * Closes the core so it can start somewhere else, cutting nothing short: it refuses while agents work, and so does a
   * running shell. The core waits for more than an update does, since this place stays closed until someone switches
   * back. Gives the reason it stays, in a switch's own words, or null once it has gone.
   */
  async closeToSwitch(): Promise<string | null> {
    if (this.phase === "updating") return "OpenOrc is installing an update. Switch after it has restarted.";
    if (this.phase === "quitting") return "OpenOrc is quitting.";
    if (!this.deps.shells.hold()) return "A terminal still has a shell running. Use End shell in each terminal, then switch.";
    this.phase = "switching";
    const closing = this.core;
    const blocked = await this.end(closing);
    // A quit that began meanwhile takes over: nothing starts anywhere else.
    if (this.phase !== "switching") return blocked ?? "OpenOrc is quitting.";
    if (!blocked) return null;
    this.phase = "serving";
    this.deps.shells.release();
    // Windows turned away meanwhile have no core, and neither has any window if this one ended without closing cleanly.
    this.deps.reload(this.core === closing ? this.turnedAway : this.deps.everyWindow());
    this.turnedAway.clear();
    return blocked;
  }

  /** Starts the core again, where the preference now says, and reloads every window onto it; then adds `folder` as a project there. */
  restart(folder?: string): void {
    // Shells and pages belong to the place that is being left.
    this.deps.leave();
    if (this.phase === "switching") this.phase = "serving";
    this.turnedAway.clear();
    if (folder) this.folderToAdd = folder;
    // Never a second core beside one that is still running: both would write the same ledger.
    const core = this.core ?? this.start();
    const adding = this.folderToAdd;
    if (adding)
      this.deps.importProject(core, adding, (error) => {
        if (this.folderToAdd === adding) this.folderToAdd = null;
        if (error) this.deps.folderNotAdded(adding, error);
      });
    this.deps.reload(this.deps.everyWindow());
  }

  /** Closes the core to install an update, or gives the reason it would not close. */
  async closeForUpdate(): Promise<string | null> {
    if (this.phase === "switching") return "OpenOrc is switching where it runs. Restart to update once it has.";
    if (!this.deps.shells.hold()) return "A terminal still has a shell running. Use End shell in each terminal, then restart to update.";
    if (this.phase !== "serving" || !this.core) {
      this.deps.shells.release();
      throw new Error("The core is unavailable. Quit and reopen OpenOrc before installing an update.");
    }
    this.phase = "updating";
    const blocked = await closeCoreForUpdate(this.core);
    if (blocked) {
      if (this.phase === "updating") this.phase = "serving";
      this.deps.shells.release();
    }
    return blocked;
  }

  /** The app is quitting. True when the core has to close first: the quit is held, and asked for again once the core has gone. */
  beforeQuit(): boolean {
    const child = this.core;
    if (!child) return false;
    if (this.phase === "quitting") return true;
    this.phase = "quitting";
    const timeout = setTimeout(() => child.kill(), QUIT_WITHIN_MS);
    child.once("exit", () => {
      clearTimeout(timeout);
      this.deps.quit();
    });
    // A core still being installed in a distribution is not there to hear a shutdown, and has nothing to close.
    if (child instanceof WslCore && child.starting) child.kill();
    else child.postMessage({ type: "shutdown" });
    return true;
  }

  private start(): CoreProcess {
    const host = this.deps.host();
    const child = this.deps.start(host);
    this.core = child;
    const inDistro = host.kind === "wsl" && child instanceof WslCore ? { name: host.distro, core: child } : null;
    let failure: string | null = null;
    inDistro?.core.on("failed", (error: Error) => (failure = error.message));
    child.on("exit", (code) => {
      // Only the core main holds now: one that was replaced has nothing left to report.
      if (this.core !== child) return;
      this.core = null;
      if (inDistro) this.stopped(inDistro.name, failure ?? stopReason(inDistro.name, code, inDistro.core.lastWords));
    });
    return child;
  }

  /**
   * A distribution that could not run the core, or stopped running it: the user tries again or goes back to this
   * computer. Asked once, and no core starts until they answer, so a window reconnecting meanwhile cannot start a second.
   * Only an answer changes where OpenOrc runs: closing the question quits, and the next start tries the distribution again.
   */
  private stopped(distro: string, reason: string): void {
    if (this.phase !== "serving") return;
    this.phase = "asking";
    void this.deps.ask(distro, reason).then((answer) => {
      // Something else took over meanwhile: a quit, or a switch chosen in Settings.
      if (this.phase !== "asking") return;
      this.phase = "serving";
      if (answer === "quit") return this.deps.quit();
      if (answer === "local") {
        this.deps.chooseLocal();
        // The folder that was waiting lives in the distribution; this computer has no such path.
        this.folderToAdd = null;
      }
      this.restart();
    });
  }

  /** Ends the core for a switch, or gives its reason for staying. */
  private async end(closing: CoreProcess | null): Promise<string | null> {
    try {
      // A core still being installed in a distribution has started nothing that ending it could cut short.
      if (closing instanceof WslCore && closing.starting) closing.kill();
      else if (closing) return await closeWhenIdle(() => closeCore(closing, "switch"));
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}
