import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { protocol, app, BrowserWindow, dialog, ipcMain, MessageChannelMain, session, shell, utilityProcess, type UtilityProcess } from "electron";
import { appOrigin, isExternalWebUrl, permitted } from "./app-origin";
import electronUpdater from "electron-updater";
import type { UpdateSettings } from "../shared/types";
import { AppUpdates } from "./app-updates";
import { configureReleaseFeed } from "./release-feed";
import { UpdatePreferences } from "./update-preferences";
import { installUpdateMenu } from "./update-menu";
import { closeCoreForUpdate } from "./update-handoff";
import { McpAppSandbox } from "./mcp-app-sandbox";
import { listenForShellEnv } from "./shell-env";
import { installProtectedSecrets } from "./protected-secrets";
import { configureAppIdentity } from "./app-identity";
import { qaDirectory } from "./qa-directory";
import { removeInjectedVariables } from "./launch-environment";
import { imageAssetResponse } from "./image-assets";
import { installImageContextMenu } from "./image-context-menu";
import { installLinkNavigation } from "./link-navigation";
import { installWindowAppearance } from "./window-appearance";
import { installProjectIcons } from "./project-icon-ipc";
import { closeAllPanes, executeBrowserCommand, installBrowserPane } from "./browser-pane";
import { installBrowserBridge } from "./browser-bridge";
import { cancelPtyUpdate, detachAllPtys, installPtyHost, killAllPtys, preparePtysForUpdate } from "./pty-host";

const here = import.meta.dirname;
const appIcon = join(here, "../../resources/icon.png");
const launchedAt = Date.now();
const TOPBAR_HEIGHT = 52;

// Before anything starts a child process, so no terminal, agent or Git command inherits them.
const ignoredLaunchVariables = removeInjectedVariables(process.env);
if (ignoredLaunchVariables.length > 0) console.log(`[main] ignored launch variables: ${ignoredLaunchVariables.join(", ")}`);

// Software rasterization reduces purgeable tile memory in this text-heavy UI.
// Keep an override for comparing performance as canvas usage changes.
if (process.env["OPENORC_GPU_RASTER"] !== "1") {
  app.commandLine.appendSwitch("disable-gpu-rasterization");
}
let coldStartMs: number | null = null;
let core: UtilityProcess | null = null;
let preparingUpdate = false;
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
// so the sandboxed renderer can display them without file:// access.
protocol.registerSchemesAsPrivileged([{ scheme: "openorc-asset", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const mcpAppSandbox = new McpAppSandbox();

/**
 * An app opened from the Dock inherits a bare PATH, and one opened from a
 * tool may inherit an odd one. Either way the user's terminal is the truth,
 * and the core is the process that asks it: the core launches the agents, so
 * Ready has to mean launchable there. Main hears every snapshot the core
 * adopts and keeps the PATH for the Terminal panels it hosts.
 */
function startCore(): UtilityProcess {
  const child = utilityProcess.fork(join(here, "core.mjs"), [], {
    serviceName: "openorc-core",
    stdio: "pipe",
    env: { ...process.env, OPENORC_DATA_DIR: app.getPath("userData") },
  });
  // A UtilityProcess hands the listener the raw payload; only MessagePorts wrap it in an event.
  listenForShellEnv(child);
  installProtectedSecrets(child, app.getPath("userData"));
  installBrowserBridge(child, executeBrowserCommand);
  child.stdout?.on("data", (d: Buffer) => process.stdout.write(`[core] ${d}`));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[core!] ${d}`));
  child.on("exit", (code) => {
    console.log(`[main] core exited with ${code}`);
    core = null;
  });
  return child;
}

/** A development build loads its UI from the dev server; a packaged app never does, whatever its environment says. */
const devServer = app.isPackaged ? undefined : process.env["ELECTRON_RENDERER_URL"];
const isAppOrigin = appOrigin({ packaged: app.isPackaged, devUrl: devServer, rendererDir: join(here, "../renderer") });
installWindowAppearance(isAppOrigin);

/** The main window, or a second one opened on a route such as a thread. The route reaches the preload as an argument. */
function createWindow(route?: string): BrowserWindow {
  const win = new BrowserWindow({
    icon: appIcon,
    width: route ? 1040 : 1280,
    height: route ? 760 : 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: "hiddenInset",
    // Center the native buttons in the shared column headers (12px buttons).
    trafficLightPosition: { x: 14, y: (TOPBAR_HEIGHT - 12) / 2 },
    // Windows keeps its own controls, drawn over the rightmost header; the renderer leaves them room.
    ...(process.platform === "win32" ? { titleBarOverlay: { height: TOPBAR_HEIGHT, color: "#00000000", symbolColor: "#b1b1b8" } } : {}),
    // Must equal the default palette's dark --bg (codex). The compositor paints this into
    // newly exposed area during a live resize, and the main process cannot read CSS vars.
    backgroundColor: "#1a1a1a",
    webPreferences: {
      preload: join(here, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      // A covered QA window must keep measuring the continuous workload.
      backgroundThrottling: !benchmarking,
      ...(route ? { additionalArguments: [`--openorc-route=${route}`] } : {}),
    },
  });
  installLinkNavigation(win, isAppOrigin);
  installImageContextMenu(win, app.getPath("userData"));
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
  win.once("ready-to-show", () => win.show());
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
  await mcpAppSandbox.start().catch((error: unknown) => console.warn("MCP Apps sandbox unavailable:", error));
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
  protocol.handle("openorc-asset", (request) => imageAssetResponse(request, app.getPath("userData")));
  core = startCore();
  installProjectIcons(isAppOrigin, app.getPath("userData"));
  const disabledUpdates = updateUnavailableReason() ?? configureReleaseFeed(electronUpdater.autoUpdater, join(process.resourcesPath, "app-update.yml"));
  const updates = new AppUpdates(electronUpdater.autoUpdater, disabledUpdates, async () => {
    if (!preparePtysForUpdate()) return "Close your running terminal panels before restarting to update.";
    preparingUpdate = true;
    if (!core) throw new Error("The core is unavailable. Quit and reopen OpenOrc before installing an update.");
    const blocked = await closeCoreForUpdate(core);
    if (blocked) {
      preparingUpdate = false;
      cancelPtyUpdate();
    }
    return blocked;
  });
  const removeUpdateMenuListener = installUpdateMenu(updates);
  const updatePreferences = new UpdatePreferences(join(app.getPath("userData"), "updates.json"));
  updates.setAutomaticChecks(updatePreferences.automaticChecks());
  const updateSettings = (): UpdateSettings => ({ automaticChecks: updatePreferences.automaticChecks(), unavailable: disabledUpdates });
  ipcMain.handle("updates:settings", (event) => {
    if (event.senderFrame !== event.sender.mainFrame || !isAppOrigin(event.senderFrame.url)) throw new Error("Only the app window can read update settings.");
    return updateSettings();
  });
  ipcMain.handle("updates:setAutomaticChecks", (event, on: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || !isAppOrigin(event.senderFrame.url)) throw new Error("Only the app window can change update settings.");
    if (typeof on !== "boolean") throw new Error("Automatic update checks are on or off.");
    updatePreferences.setAutomaticChecks(on);
    updates.setAutomaticChecks(on);
    return updateSettings();
  });
  app.once("will-quit", () => {
    removeUpdateMenuListener();
    updates.dispose();
  });

  // The renderer asks for a direct channel to the core. Main hands each side a
  // port and steps out of the way: no per-message relay through this process.
  ipcMain.on("bridge:connect", (event) => {
    if (event.senderFrame !== event.sender.mainFrame || !isAppOrigin(event.senderFrame.url)) return;
    if (preparingUpdate) return;
    if (!core) core = startCore();
    const { port1, port2 } = new MessageChannelMain();
    core.postMessage({ type: "port" }, [port1]);
    event.sender.postMessage("bridge:port", null, [port2]);
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

  ipcMain.handle("dialog:directory", async (event) => {
    // A QA build can name the repository up front; the native chooser cannot be driven by automation.
    const forced = qaDirectory();
    if (forced) return forced;
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ["openDirectory"], title: "Choose a repository" })
      : await dialog.showOpenDialog({ properties: ["openDirectory"], title: "Choose a repository" });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.on("shell:openExternal", (event, url: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || !isAppOrigin(event.senderFrame.url)) return;
    if (isExternalWebUrl(url)) void shell.openExternal(url);
  });

  ipcMain.on("shell:revealFile", (_event, path: unknown) => {
    if (typeof path === "string" && isAbsolute(path) && !path.includes("\0")) shell.showItemInFolder(path);
  });

  ipcMain.handle("window:isFullscreen", (event) => BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false);
  ipcMain.handle("window:syncChrome", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const zoom = event.sender.getZoomFactor();
    // Native buttons keep their OS size. Match their center to the zoomed header
    // and reserve their physical footprint in renderer CSS instead of scaling it.
    const height = Math.max(32, TOPBAR_HEIGHT * zoom);
    if (win && process.platform === "darwin" && !win.isFullScreen()) {
      win.setWindowButtonPosition({ x: 14, y: Math.round((height - 12) / 2) });
    } else if (win && process.platform === "win32") {
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

let quitting = false;
app.on("before-quit", (event) => {
  // Unconditional and ahead of the core's shutdown: shells and panes are
  // children of this process, and a window with no core still has both. Left
  // alone the shells outlive the app as orphans holding whatever was running.
  killAllPtys();
  closeAllPanes();
  if (!core) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  const child = core;
  const timeout = setTimeout(() => child.kill(), 12_000);
  child.once("exit", () => {
    clearTimeout(timeout);
    app.quit();
  });
  child.postMessage({ type: "shutdown" });
});

function updateUnavailableReason(): string | null {
  if (!app.isPackaged) return "Run an installed release of OpenOrc to receive updates. Development builds do not contact the update service.";
  if (!["darwin", "win32"].includes(process.platform)) return "Automatic updates are currently supported on macOS and Windows.";
  if (!existsSync(join(process.resourcesPath, "app-update.yml"))) return "This build has no release repository configured. Install an official release to receive updates.";
  return null;
}
