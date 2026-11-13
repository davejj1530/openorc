import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { protocol, app, BrowserWindow, dialog, ipcMain, MessageChannelMain, session, shell, utilityProcess, type UtilityProcess, type WebContents } from "electron";
import { appOrigin, isExternalWebUrl, permitted } from "./app-origin";
import electronUpdater from "electron-updater";
import { AppUpdates } from "./app-updates";
import { configureReleaseFeed } from "./release-feed";
import { installUpdateControls } from "./update-ipc";
import { installUpdateMenu } from "./update-menu";
import { hostSandboxFrames, isolateSandboxFrames, McpAppSandbox } from "./mcp-app-sandbox";
import { forgetShellEnv, listenForShellEnv } from "./shell-env";
import { installProtectedSecrets } from "./protected-secrets";
import { configureAppIdentity } from "./app-identity";
import { qaDirectory } from "./qa-directory";
import { removeInjectedVariables } from "./launch-environment";
import { FILE_SCHEME } from "@openorc/core/file-url";
import { imageAssetResponse } from "./image-assets";
import { installFileViewer } from "./file-viewer";
import { installImageContextMenu } from "./image-context-menu";
import { installLinkNavigation } from "./link-navigation";
import { installWindowAppearance } from "./window-appearance";
import { installProjectIcons, type ProjectFolder } from "./project-icon-ipc";
import { closeAllPanes, executeBrowserCommand, installBrowserPane } from "./browser-pane";
import { installBrowserBridge } from "./browser-bridge";
import { installPreviewBridge } from "./preview-bridge";
import { createPreviewHost } from "./preview-host";
import { installPresence } from "./presence-ipc";
import { installTrash } from "./trash-ipc";
import { installPowerEvents } from "./power-ipc";
import { cancelPtyUpdate, detachAllPtys, installPtyHost, killAllPtys, preparePtysForUpdate } from "./pty-host";
import { HostPreferences, hostPaths, localPaths, useHostPaths } from "./host";
import { connectWindow, hostCores, type CoreProcess } from "./host-core";
import { importProject, installHostControls } from "./host-controls";
import { CoreLifecycle, type DistroAnswer } from "./core-lifecycle";
import { thisComputer, type HostChoice } from "../shared/host";

const here = import.meta.dirname;
const appIcon = join(here, "../../resources/icon.png");
const launchedAt = Date.now();
const TOPBAR_HEIGHT = 44;
const TRAFFIC_LIGHT_DIAMETER = 14;

// Before anything starts a child process, so no terminal, agent or Git command inherits them.
const ignoredLaunchVariables = removeInjectedVariables(process.env);
if (ignoredLaunchVariables.length > 0) console.log(`[main] ignored launch variables: ${ignoredLaunchVariables.join(", ")}`);

// Software rasterization reduces purgeable tile memory in this text-heavy UI.
// Keep an override for comparing performance as canvas usage changes.
if (process.env["OPENORC_GPU_RASTER"] !== "1") {
  app.commandLine.appendSwitch("disable-gpu-rasterization");
}
isolateSandboxFrames(app.commandLine);
let coldStartMs: number | null = null;
/** How long Node's archive may take to arrive before setup gives up on the download. */
const NODE_DOWNLOAD_MS = 10 * 60_000;
// Visual QA and CI switches. A release build compiles them out and ignores these variables.
const screenshot = __OPENORC_QA__ ? process.env["OPENORC_SCREENSHOT"] : undefined;
const autoquit = __OPENORC_QA__ && process.env["OPENORC_AUTOQUIT"] === "1";
const benchmarking = __OPENORC_QA__ && ["OPENORC_AUTOBENCH", "OPENORC_AUTOBENCH_THREAD"].some((name) => process.env[name] === "1");

// A packaged app accepts no remote debugging: any program could otherwise relaunch it with a debugging port and drive
// its windows, the Preview's signed-in sessions included. Node's --inspect is switched off by a fuse instead.
if (app.isPackaged && ["remote-debugging-port", "remote-debugging-pipe"].some((name) => app.commandLine.hasSwitch(name))) {
  console.error("OpenOrc does not accept remote debugging.");
  app.exit(1);
}

configureAppIdentity(app);
if (!app.requestSingleInstanceLock()) {
  if (process.env["ELECTRON_RENDERER_URL"]) {
    console.error("[main] Development launch stopped: another OpenOrc instance is using this data folder. Quit the existing app, then run pnpm dev again to enable hot reload.");
    app.exit(1);
  } else app.exit(0);
}
app.on("second-instance", () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win?.isMinimized()) win.restore();
  win?.show();
  win?.focus();
});

// Attachments and local image artifacts use an image-only private scheme,
// so the sandboxed renderer can display them without file:// access. Files
// opened in the file panel stream over their own scheme, which never counts
// as the app's origin: a URL there names a file only with the core's signature.
protocol.registerSchemesAsPrivileged([
  { scheme: "openorc-asset", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: FILE_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
]);
// Signs the file panel's viewer URLs. The core gets it once, at fork; main verifies every URL with it.
const fileKey = randomBytes(32).toString("hex");
// On this computer every path the core names is the path main opens. A core inside a WSL distribution names Linux
// paths, which main opens through the share Windows mounts for the distribution; these two and the file panel's
// viewer are where they cross.
/** Images of the profile and of the conversation's folder, read where the core that named them keeps them. */
const assetResponse = (request: Request) => imageAssetResponse(request, hostPaths().dataDir(), hostPaths().toMain);
const projectFolder: ProjectFolder = (rootPath) => {
  const paths = hostPaths();
  return paths.distro ? { folder: paths.toMain(rootPath), shown: rootPath } : { folder: normalize(rootPath), shown: normalize(rootPath) };
};
const previewHost = createPreviewHost();
// QA builds let a kit reach the host through main's inspector, to time captures against the real panes.
if (__OPENORC_QA__) Object.assign(globalThis, { __openorcPreview: previewHost });
const mcpAppSandbox = new McpAppSandbox();

/** The core on this computer, in Electron's utility process. */
function forkCore(): UtilityProcess {
  const child = utilityProcess.fork(join(here, "core.mjs"), [], {
    serviceName: "openorc-core",
    stdio: "pipe",
    env: { ...process.env, OPENORC_DATA_DIR: app.getPath("userData"), OPENORC_FILE_KEY: fileKey, ...(app.isPackaged ? { OPENORC_BRAIN_DIR: join(process.resourcesPath, "brain") } : {}) },
  });
  child.stdout?.on("data", (d: Buffer) => process.stdout.write(`[core] ${d}`));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[core!] ${d}`));
  useHostPaths(localPaths(app.getPath("userData")));
  return child;
}

/**
 * Where the core runs is this computer unless someone chose a WSL distribution in Settings, on Windows. The file is
 * read at each start, and the app carries the core for a distribution beside the cloud brain.
 */
const hostPreferences = new HostPreferences(join(app.getPath("userData"), "host.json"));
const cores = hostCores({
  userData: app.getPath("userData"),
  coreDir: app.isPackaged ? join(process.resourcesPath, "wsl") : join(here, "../../dist/wsl"),
  brainDir: app.isPackaged ? join(process.resourcesPath, "brain") : join(here, "../../../brain/dist"),
  fileKey,
  qa: __OPENORC_QA__,
  // Through Chromium's network stack, so a proxy this PC uses is honoured, in a session of its own: the windows'
  // session reaches only the hosts the MCP App sandbox lets through.
  fetchNode: async (url, signal) => {
    const waited = AbortSignal.timeout(NODE_DOWNLOAD_MS);
    const response = await session.fromPartition("openorc-wsl-runtime").fetch(url, { signal: signal ? AbortSignal.any([signal, waited]) : waited });
    if (!response.ok) throw new Error(`nodejs.org answered ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  },
});
const currentHost = () => cores.choice(hostPreferences.choice());

/** Asks what to do about a distribution that could not run the core, or stopped running it. Closing the question quits. */
async function askAboutDistro(distro: string, reason: string): Promise<DistroAnswer> {
  console.error(`[main] the core in WSL: ${distro} stopped: ${reason}`);
  const buttons = ["Try again", `Run on ${thisComputer(process.platform)}`, "Quit OpenOrc"];
  const { response } = await dialog.showMessageBox({ type: "error", message: `OpenOrc could not run in WSL: ${distro}`, detail: reason, buttons, defaultId: 0, cancelId: 2 });
  return (["retry", "local", "quit"] as const)[response] ?? "quit";
}

/**
 * An app opened from the Dock inherits a bare PATH, and one opened from a
 * tool may inherit an odd one. Either way the user's terminal is the truth,
 * and the core is the process that asks it: the core launches the agents, so
 * Ready has to mean launchable there. Main hears every snapshot the core
 * adopts and keeps the PATH for the Terminal panels it hosts outside macOS.
 */
function startCore(host: HostChoice): CoreProcess {
  const child: CoreProcess = host.kind === "wsl" ? cores.start(host.distro) : forkCore();
  // A UtilityProcess hands the listener the raw payload; only MessagePorts wrap it in an event.
  listenForShellEnv(child);
  installProtectedSecrets(child, cores.secretsDir(host));
  installBrowserBridge(child, executeBrowserCommand);
  installPreviewBridge(child, previewHost);
  installPresence(child);
  installTrash(child);
  installPowerEvents(child);
  child.on("exit", (code) => console.log(`[main] core exited with ${code}`));
  return child;
}

/** Says a folder could not be added as a project where OpenOrc now runs. The windows have reloaded and have no request of their own to show it under. */
function folderNotAdded(folder: string, reason: string): void {
  console.error(`[main] ${folder} was not added as a project: ${reason}`);
  void dialog.showMessageBox({ type: "error", message: "OpenOrc could not add this folder as a project", detail: `${folder}\n\n${reason}`, buttons: ["OK"] });
}

const lifecycle = new CoreLifecycle<WebContents>({
  host: currentHost,
  start: startCore,
  // The renderer asks for a direct channel to the core. Main hands each side a port and steps out of the way: no
  // per-message relay through this process. The second channel carries device video, so a stream never queues behind
  // RPC replies.
  connect(core, window) {
    const rpc = new MessageChannelMain();
    const media = new MessageChannelMain();
    connectWindow(core, rpc.port1, media.port1);
    window.postMessage("bridge:port", null, [rpc.port2, media.port2]);
  },
  everyWindow: () => BrowserWindow.getAllWindows().map((win) => win.webContents),
  reload(windows) {
    for (const contents of windows) {
      if (!contents.isDestroyed()) contents.reload();
    }
  },
  leave() {
    killAllPtys();
    cancelPtyUpdate();
    closeAllPanes();
    forgetShellEnv();
  },
  shells: { hold: preparePtysForUpdate, release: cancelPtyUpdate },
  ask: askAboutDistro,
  chooseLocal: () => hostPreferences.set({ kind: "local" }),
  quit: () => app.quit(),
  importProject,
  folderNotAdded,
});

/** A development build loads its UI from the dev server; a packaged app never does, whatever its environment says. */
const devServer = app.isPackaged ? undefined : process.env["ELECTRON_RENDERER_URL"];
const isAppOrigin = appOrigin({ packaged: app.isPackaged, devUrl: devServer, rendererDir: join(here, "../renderer") });
installWindowAppearance(isAppOrigin);
const hostControls = installHostControls({
  preferences: hostPreferences,
  current: currentHost,
  distros: cores.distros,
  isAppOrigin,
  closeCore: () => lifecycle.closeToSwitch(),
  restart: (folder) => lifecycle.restart(folder),
  thisComputer: thisComputer(process.platform),
  home: cores.home,
});

/** The main window, or a second one opened on a route such as a thread. The route reaches the preload as an argument. */
function createWindow(route?: string): BrowserWindow {
  const win = new BrowserWindow({
    icon: appIcon,
    width: route ? 1040 : 1280,
    height: route ? 760 : 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    // Linux ignores hiddenInset and would keep its own title bar and menu bar above our headers.
    titleBarStyle: process.platform === "linux" ? "hidden" : "hiddenInset",
    // Native macOS buttons are 14px tall and keep their size when the page zooms.
    trafficLightPosition: { x: 16, y: (TOPBAR_HEIGHT - TRAFFIC_LIGHT_DIAMETER) / 2 },
    // Windows and Linux keep their own controls, drawn over the header; the renderer leaves them room.
    ...(process.platform !== "darwin" ? { titleBarOverlay: { height: TOPBAR_HEIGHT, color: "#00000000", symbolColor: "#b1b1b8" } } : {}),
    // Must equal the default palette's dark --bg (codex). The compositor paints this into
    // newly exposed area during a live resize, and the main process cannot read CSS vars.
    backgroundColor: "#1a1a1a",
    webPreferences: {
      preload: join(here, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      // The file panel shows PDFs in Chromium's viewer, which is a plugin.
      plugins: true,
      // A covered QA window must keep measuring the continuous workload.
      backgroundThrottling: !benchmarking,
      ...(route ? { additionalArguments: [`--openorc-route=${route}`] } : {}),
    },
  });
  installLinkNavigation(win, isAppOrigin);
  installImageContextMenu(win, app.getPath("userData"), assetResponse);
  hostSandboxFrames(win.webContents);
  // A reload replaces the page without running React cleanup, so no panel gets
  // to say it stopped watching its shell. Main drops every viewer here and
  // lets the new page attach again; the shells keep running throughout.
  win.webContents.on("did-start-navigation", (event) => {
    if (event.isMainFrame) {
      detachAllPtys();
      mcpAppSandbox.releaseOwner(win.webContents.id);
    }
  });
  const appOwner = win.webContents.id;
  win.webContents.once("destroyed", () => mcpAppSandbox.releaseOwner(appOwner));
  const reveal = () => {
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  };
  win.once("ready-to-show", reveal);
  // On Wayland Chromium stops painting a window that has never been shown, so ready-to-show can wait forever.
  if (process.platform === "linux") win.webContents.once("did-finish-load", reveal);
  // The columns give the traffic lights room only while there are traffic lights to give room to.
  const tellFullscreen = () => win.webContents.send("window:fullscreen", win.isFullScreen());
  win.on("enter-full-screen", tellFullscreen);
  win.on("leave-full-screen", tellFullscreen);
  if (screenshot || process.env["OPENORC_RENDERER_LOG"] === "1") {
    win.webContents.on("console-message", (event) => {
      if (event.level === "warning" || event.level === "error") console.log(`[renderer:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
    });
  }
  win.webContents.on("did-finish-load", () => {
    coldStartMs = Date.now() - launchedAt;
    console.log(`[main] cold start to did-finish-load: ${coldStartMs} ms`);
    // Visual QA: OPENORC_SCREENSHOT=/path.png captures the window after it settles.
    if (screenshot) {
      setTimeout(
        async () => {
          const image = await win.webContents.capturePage();
          await writeFile(screenshot, image.toPNG());
          console.log(`[main] screenshot written to ${screenshot}`);
          if (autoquit) app.quit();
        },
        Number(process.env["OPENORC_SCREENSHOT_DELAY_MS"] ?? 2500),
      );
    }
  });
  if (devServer) {
    console.log(`[main] Development window: ${devServer} (UI hot reload enabled)`);
    void win.loadURL(devServer);
  } else {
    void win.loadFile(join(here, "../renderer/index.html"));
  }
  return win;
}

app.whenReady().then(async () => {
  // The app window may show notifications and copy text; nothing else, and nothing for another page or embedded frame.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => callback(permitted(permission, details.requestingUrl, isAppOrigin)));
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => permitted(permission, details.requestingUrl ?? contents?.getURL() ?? "", isAppOrigin));
  await mcpAppSandbox.start({ session: session.defaultSession, direct: devServer ? [new URL(devServer).host] : [] }).catch((error: unknown) => console.warn("MCP Apps sandbox unavailable:", error));
  ipcMain.handle("mcp-app:register", (event, document: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || !isAppOrigin(event.senderFrame.url)) throw new Error("Only the app window can host MCP Apps.");
    return mcpAppSandbox.register(event.sender.id, document);
  });
  ipcMain.on("mcp-app:release", (event, id: unknown) => {
    if (event.senderFrame === event.sender.mainFrame && typeof id === "string") mcpAppSandbox.release(event.sender.id, id);
  });
  app.once("will-quit", () => {
    void mcpAppSandbox.close();
  });
  // Development runs inside Electron.app, whose bundle still has Electron's icon.
  app.dock?.setIcon(appIcon);
  protocol.handle("openorc-asset", assetResponse);
  installFileViewer(fileKey, isAppOrigin, hostPaths);
  lifecycle.begin();
  installProjectIcons(isAppOrigin, app.getPath("userData"), projectFolder);
  const disabledUpdates = updateUnavailableReason() ?? configureReleaseFeed(electronUpdater.autoUpdater, join(process.resourcesPath, "app-update.yml"));
  const updates = new AppUpdates(electronUpdater.autoUpdater, disabledUpdates, () => lifecycle.closeForUpdate());
  const removeUpdateMenuListener = installUpdateMenu(updates);
  const removeUpdateControls = installUpdateControls(updates, join(app.getPath("userData"), "updates.json"), isAppOrigin, createWindow);
  app.once("will-quit", () => {
    removeUpdateControls();
    removeUpdateMenuListener();
    updates.dispose();
  });

  ipcMain.on("bridge:connect", (event) => {
    if (event.senderFrame !== event.sender.mainFrame || !isAppOrigin(event.senderFrame.url)) return;
    lifecycle.connect(event.sender);
  });

  ipcMain.handle("metrics", () => ({
    coldStartMs,
    processes: app.getAppMetrics().map((m) => ({
      pid: m.pid,
      type: m.type,
      name: m.name ?? m.serviceName ?? "",
      workingSetKb: m.memory.workingSetSize,
      privateKb: m.memory.privateBytes ?? 0,
      cpuPercent: m.cpu.percentCPUUsage,
    })),
  }));

  ipcMain.handle("dialog:directory", async (event, purpose: unknown) => {
    // A QA build can name the repository up front; the native chooser cannot be driven by automation.
    const forced = qaDirectory();
    if (forced) return forced;
    return hostControls.pickFolder(BrowserWindow.fromWebContents(event.sender), purpose === "project");
  });

  ipcMain.on("shell:openExternal", (event, url: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || !isAppOrigin(event.senderFrame.url)) return;
    if (isExternalWebUrl(url)) void shell.openExternal(url);
  });

  ipcMain.on("shell:revealFile", (_event, path: unknown) => {
    if (typeof path === "string" && isAbsolute(path) && !path.includes("\0")) shell.showItemInFolder(hostPaths().toMain(path));
  });

  ipcMain.handle("window:isFullscreen", (event) => BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false);
  ipcMain.handle("window:syncChrome", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const zoom = event.sender.getZoomFactor();
    // Native buttons keep their OS size. Match their center to the zoomed header
    // and reserve their physical footprint in renderer CSS instead of scaling it.
    const height = Math.max(32, TOPBAR_HEIGHT * zoom);
    if (win && process.platform === "darwin" && !win.isFullScreen()) {
      win.setWindowButtonPosition({ x: 16, y: Math.round((height - TRAFFIC_LIGHT_DIAMETER) / 2) });
    } else if (win && process.platform !== "darwin") {
      win.setTitleBarOverlay({ height: Math.round(height) });
    }
    return zoom;
  });

  // Both panes talk to main rather than the core, and for the same reason: the
  // core writes everything it emits to the ledger and buffers frames without a
  // bound, neither of which suits a byte stream nobody asked for. Installed
  // once for the process because a shell outlives the window that opened it.
  installPtyHost(ipcMain, { getWindow: () => BrowserWindow.getAllWindows()[0] ?? null, getWindows: () => BrowserWindow.getAllWindows() });
  installBrowserPane(ipcMain, { getWindow: () => BrowserWindow.getAllWindows()[0] ?? null });

  ipcMain.on("window:open", (_event, route: unknown) => {
    if (typeof route === "string" && /^[a-z]+(:[A-Za-z0-9-]+){0,2}$/.test(route)) createWindow(route);
  });

  if (__OPENORC_QA__)
    ipcMain.on("report", (_event, payload: unknown) => {
      console.log(`[report] ${JSON.stringify(payload)}`);
      const isFinal = typeof payload === "object" && payload !== null && (payload as { final?: boolean }).final === true;
      if (autoquit && isFinal) setTimeout(() => app.quit(), 200);
    });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || autoquit) app.quit();
});

app.on("before-quit", (event) => {
  // Unconditional and ahead of the core's shutdown: shells and panes are
  // children of this process, and a window with no core still has both. Left
  // alone the shells outlive the app as orphans holding whatever was running.
  killAllPtys();
  closeAllPanes();
  if (lifecycle.beforeQuit()) event.preventDefault();
});

function updateUnavailableReason(): string | null {
  if (!app.isPackaged) return "Run an installed release of OpenOrc to receive updates. Development builds do not contact the update service.";
  if (process.platform === "linux") return "OpenOrc does not update itself on Linux yet. Install new versions from its GitHub releases.";
  if (!["darwin", "win32"].includes(process.platform)) return "Automatic updates are currently supported on macOS and Windows.";
  if (!existsSync(join(process.resourcesPath, "app-update.yml"))) return "This build has no release repository configured. Install an official release to receive updates.";
  return null;
}
