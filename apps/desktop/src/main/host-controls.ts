import { dialog, ipcMain, MessageChannelMain, type BrowserWindow, type IpcMainInvokeEvent, type OpenDialogOptions } from "electron";
import { hostName, sameHost, type HostChoice, type HostState, type HostSwitch } from "../shared/host";
import { hostPaths, type HostPreferences } from "./host";
import { connectWindow, type CoreProcess } from "./host-core";
import type { CloseRefusal } from "./update-handoff";
import type { WslDistroInfo } from "./wsl/distros";
import { parseWslPath } from "./wsl/paths";

/** What to do with a folder the user chose, given where the core runs. */
export type FolderPlacement =
  /** The core opens it, by this path. */
  | { kind: "open"; path: string }
  /**
   * It lives where another core would run: `host`, by `path` there. `direct` is the path this core could still open it
   * by, as Windows opens a distribution's share; null when it cannot reach it at all.
   */
  | { kind: "elsewhere"; host: HostChoice; path: string; direct: string | null };

/**
 * Where a chosen folder belongs. On this computer every folder opens as it always has, except one inside a WSL
 * distribution, which the core in that distribution should open. A core inside a distribution opens what is inside
 * it, and anything else belongs to another distribution or to this PC.
 */
export function placeFolder(picked: string, current: HostChoice, toCore: (path: string) => string | null, platform: NodeJS.Platform = process.platform): FolderPlacement {
  const share = platform === "win32" ? parseWslPath(picked) : null;
  if (current.kind === "local") return share ? { kind: "elsewhere", host: { kind: "wsl", distro: share.distro }, path: share.path, direct: picked } : { kind: "open", path: picked };
  const inside = toCore(picked);
  if (inside) return { kind: "open", path: inside };
  return share ? { kind: "elsewhere", host: { kind: "wsl", distro: share.distro }, path: share.path, direct: null } : { kind: "elsewhere", host: { kind: "local" }, path: picked, direct: null };
}

/**
 * Closes the core for a switch. A request caught mid-flight refuses the close for a moment, which an update leaves to
 * the person to try again; a switch waits it out, and gives up with the core's words only if requests never pause.
 */
export async function closeWhenIdle(close: () => Promise<CloseRefusal | null>, { attempts = 40, waitMs = 500 } = {}): Promise<string | null> {
  for (let attempt = 1; ; attempt++) {
    const refusal = await close();
    if (!refusal) return null;
    if (!refusal.retry || attempt >= attempts) return refusal.reason;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

/**
 * Adds a folder as a project on a core that is starting, over a channel of main's own: the windows are reloading and
 * cannot ask yet. The core tells every window the project list changed, so the folder is there when they look. `done`
 * hears the core's answer, with its reason when it refused; a core that stops first never answers.
 */
export function importProject(core: CoreProcess, rootPath: string, done: (error?: string) => void = () => undefined): void {
  const rpc = new MessageChannelMain();
  const media = new MessageChannelMain();
  let asked = false;
  const close = () => {
    core.removeListener("exit", close);
    rpc.port2.close();
    media.port2.close();
  };
  const ask = () => {
    if (asked) return;
    asked = true;
    rpc.port2.postMessage({ type: "rpc", id: 1, method: "projects.import", params: { rootPath } });
  };
  const answered = (error?: string) => {
    close();
    done(error);
  };
  rpc.port2.on("message", (event) => {
    const push = event.data as { type?: unknown; id?: unknown; message?: unknown } | null;
    if (push?.type === "ready") ask();
    else if (push?.id !== 1) return;
    else if (push.type === "rpc.result") answered();
    else if (push.type === "rpc.error") answered(String(push.message ?? "The folder could not be added."));
  });
  core.once("exit", close);
  rpc.port2.start();
  connectWindow(core, rpc.port1, media.port1);
}

export interface HostControlsDeps {
  preferences: HostPreferences;
  /** Where the core runs now: the preference, as this computer can honour it. */
  current(): HostChoice;
  distros(): Promise<WslDistroInfo[]>;
  isAppOrigin(url: string): boolean;
  /** Closes the running core cleanly so one can start elsewhere, or says why it cannot close now, in words for a switch. */
  closeCore(): Promise<string | null>;
  /** Starts a core where the preference now says, with every window reloaded onto it; then adds `folder` as a project there. */
  restart(folder?: string): void;
  /** "this PC", as the app calls the machine. */
  thisComputer: string;
  /** The system the app runs on: only Windows has a share to find a distribution's folder under. */
  platform?: NodeJS.Platform;
  /** The user's home inside the distribution the core runs in, where the folder chooser opens. */
  home(): string | null;
}

export interface HostControls {
  /**
   * The folder chooser: resolves the folder as the core names it, or null when none was chosen or the app is switching
   * for it. Only a folder chosen to be a project offers to switch to where it lives, and is added as a project there;
   * any other folder is one the core here uses, so it opens from here or not at all.
   */
  pickFolder(window: BrowserWindow | null, forProject: boolean): Promise<string | null>;
  use(host: HostChoice, folder?: string): Promise<HostSwitch>;
}

function parseChoice(value: unknown): HostChoice | null {
  if (!value || typeof value !== "object") return null;
  const { kind, distro } = value as { kind?: unknown; distro?: unknown };
  if (kind === "local") return { kind: "local" };
  return kind === "wsl" && typeof distro === "string" && /^[\w.-]{1,128}$/.test(distro) ? { kind: "wsl", distro } : null;
}

/** A distribution as WSL itself spells it, however the caller did: a folder's path may name it in another case. Null when it is not listed. */
function listed(host: HostChoice, distros: readonly { name: string }[]): HostChoice | null {
  const found = distros.find((distro) => sameHost({ kind: "wsl", distro: distro.name }, host));
  return found ? { kind: "wsl", distro: found.name } : null;
}

/**
 * Asked on this PC about a project's folder inside a distribution: run there, or open the share from Windows as
 * before. It says what the switch leaves waiting here before anyone agrees to it.
 */
function runInDistroQuestion(distro: string, target: string, thisComputer: string): Electron.MessageBoxOptions {
  return {
    type: "question",
    message: `This folder is inside WSL (${distro})`,
    detail: [
      `OpenOrc can run inside ${distro}, where it uses the agents, Git and shell you have there, as a terminal in ${distro} does. Opened from Windows instead, the folder is a network share: Windows’ own tools work on it slowly, and agents installed in ${distro} are not used.`,
      `Running in ${distro} restarts OpenOrc there, with its own projects, conversations and sign-ins. What runs on ${thisComputer} waits until you switch back under Settings > General: its schedules, Slack and phone access. The first time, OpenOrc installs what it needs in ${distro}, including its own copy of Node from nodejs.org.`,
    ].join("\n\n"),
    buttons: [`Run in ${target}`, "Open from Windows", "Cancel"],
    defaultId: 0,
    cancelId: 2,
  };
}

/** Asked about a project's folder that the place OpenOrc runs in cannot open at all: switch to where it lives, or leave it. */
function switchQuestion(here: string, target: string): Electron.MessageBoxOptions {
  return {
    type: "question",
    message: `This folder is not inside ${here}`,
    detail: `OpenOrc is running in ${here} and opens folders there. To open this one it switches to ${target}. Your projects stay where they are, their schedules, Slack and phone access wait meanwhile, and Settings > General switches back.`,
    buttons: [`Switch to ${target}`, "Cancel"],
    defaultId: 0,
    cancelId: 1,
  };
}

/**
 * Where OpenOrc runs, for the windows: what Settings shows and changes, and the folder chooser, which knows that a
 * folder inside a distribution belongs to the core in that distribution.
 */
export function installHostControls(deps: HostControlsDeps): HostControls {
  let switching: Promise<HostSwitch> | null = null;

  const use = (host: HostChoice, folder?: string): Promise<HostSwitch> => {
    if (switching) return Promise.resolve({ ok: false, reason: "OpenOrc is already switching where it runs." });
    const work = (async (): Promise<HostSwitch> => {
      if (sameHost(deps.current(), host)) return { ok: true };
      const target = host.kind === "wsl" ? listed(host, await deps.distros()) : host;
      if (!target) return { ok: false, reason: `${hostName(host, deps.thisComputer)} is not installed on this PC.` };
      const blocked = await deps.closeCore();
      if (blocked) return { ok: false, reason: blocked };
      deps.preferences.set(target);
      deps.restart(folder);
      return { ok: true };
    })();
    switching = work;
    void work.finally(() => (switching = null)).catch(() => undefined);
    return work;
  };

  const ask = async (window: BrowserWindow | null, options: Electron.MessageBoxOptions): Promise<number> =>
    (window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)).response;

  /** Switches for a folder that lives elsewhere, once the user agrees; says why when it cannot. */
  const switchFor = async (window: BrowserWindow | null, host: HostChoice, folder: string): Promise<void> => {
    const result = await use(host, folder);
    if (!result.ok) await ask(window, { type: "info", message: `OpenOrc can’t switch to ${hostName(host, deps.thisComputer)} yet`, detail: result.reason, buttons: ["OK"] });
  };

  const elsewhere = async (window: BrowserWindow | null, placement: Extract<FolderPlacement, { kind: "elsewhere" }>): Promise<string | null> => {
    const current = deps.current();
    const target = hostName(placement.host, deps.thisComputer);
    if (current.kind === "local" && placement.host.kind === "wsl") {
      const choice = await ask(window, runInDistroQuestion(placement.host.distro, target, deps.thisComputer));
      if (choice === 1) return placement.direct;
      if (choice === 0) await switchFor(window, placement.host, placement.path);
      return null;
    }
    const choice = await ask(window, switchQuestion(hostName(current, deps.thisComputer), target));
    if (choice === 0) await switchFor(window, placement.host, placement.path);
    return null;
  };

  /** A folder the core here was to use, such as a skill's, that lives where it cannot reach. */
  const outOfReach = async (window: BrowserWindow | null): Promise<null> => {
    const here = hostName(deps.current(), deps.thisComputer);
    await ask(window, {
      type: "info",
      message: `This folder is not inside ${here}`,
      detail: `OpenOrc is running in ${here} and can only use folders there. Choose a folder inside it.`,
      buttons: ["OK"],
    });
    return null;
  };

  const pickFolder = async (window: BrowserWindow | null, forProject: boolean): Promise<string | null> => {
    const paths = hostPaths();
    const home = paths.distro ? deps.home() : null;
    const options: OpenDialogOptions = { properties: ["openDirectory", "createDirectory"], title: "Choose a repository", ...(home ? { defaultPath: paths.toMain(home) } : {}) };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    const picked = result.canceled ? null : (result.filePaths[0] ?? null);
    if (!picked) return null;
    const placement = placeFolder(picked, deps.current(), paths.toCore, deps.platform);
    if (placement.kind === "open") return placement.path;
    if (forProject) return elsewhere(window, placement);
    return placement.direct ?? outOfReach(window);
  };

  const fromApp = (event: IpcMainInvokeEvent): void => {
    if (event.senderFrame !== event.sender.mainFrame || !deps.isAppOrigin(event.senderFrame?.url ?? "")) throw new Error("Only the app window can choose where OpenOrc runs.");
  };
  ipcMain.handle("host:get", async (event): Promise<HostState> => {
    fromApp(event);
    const distros = (await deps.distros()).map((distro) => ({ name: distro.name, default: distro.default }));
    const chosen = deps.current();
    const current = listed(chosen, distros) ?? chosen;
    // The place OpenOrc runs in is always offered, even when wsl.exe would not list it just now: the way back must not disappear.
    if (current.kind === "wsl" && !distros.some((distro) => distro.name === current.distro)) distros.push({ name: current.distro, default: false });
    return { current, distros };
  });
  ipcMain.handle("host:use", (event, value: unknown): Promise<HostSwitch> => {
    fromApp(event);
    const host = parseChoice(value);
    return host ? use(host) : Promise.resolve({ ok: false, reason: "That is not a place OpenOrc can run." });
  });

  return { pickFolder, use };
}
