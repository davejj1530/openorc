import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { AppMetrics, BrowserPaneState, OpenOrcApi, UpdateSettings } from "../shared/types";
import { readAutorun } from "./autorun";

const api: OpenOrcApi = {
  projectIcons: {
    get: (rootPath) => ipcRenderer.invoke("project-icons:get", rootPath),
    refresh: (rootPath) => ipcRenderer.invoke("project-icons:refresh", rootPath),
    choose: (rootPath, choice) => ipcRenderer.invoke("project-icons:choose", rootPath, choice),
    pick: (rootPath) => ipcRenderer.invoke("project-icons:pick", rootPath),
    onChanged(callback) {
      const listener = (_event: unknown, rootPath: string, state: import("../shared/project-icons").ProjectIconState) => callback(rootPath, state);
      ipcRenderer.on("project-icons:changed", listener);
      return () => ipcRenderer.off("project-icons:changed", listener);
    },
  },
  mcpApps: {
    register: (document) => ipcRenderer.invoke("mcp-app:register", document),
    release: (id) => ipcRenderer.send("mcp-app:release", id),
  },
  /** Ask main for a MessagePort to the core. The port arrives via window.postMessage. */
  connectBridge() {
    ipcRenderer.send("bridge:connect");
  },
  metrics() {
    return ipcRenderer.invoke("metrics") as Promise<AppMetrics>;
  },
  report(payload) {
    ipcRenderer.send("report", payload);
  },
  pickDirectory() {
    return ipcRenderer.invoke("dialog:directory") as Promise<string | null>;
  },
  filePath(file) {
    return webUtils.getPathForFile(file);
  },
  openExternal(url) {
    ipcRenderer.send("shell:openExternal", url);
  },
  revealFile(path) {
    ipcRenderer.send("shell:revealFile", path);
  },
  openWindow(route) {
    ipcRenderer.send("window:open", route);
  },
  isFullscreen() {
    return ipcRenderer.invoke("window:isFullscreen") as Promise<boolean>;
  },
  syncWindowChrome() {
    return ipcRenderer.invoke("window:syncChrome") as Promise<number>;
  },
  syncWindowAppearance(appearance) {
    return ipcRenderer.invoke("window:appearance", appearance);
  },
  onFullscreen(cb) {
    const listener = (_event: unknown, fullscreen: unknown) => cb(fullscreen === true);
    ipcRenderer.on("window:fullscreen", listener);
    return () => ipcRenderer.off("window:fullscreen", listener);
  },
  platform: process.platform,
  updates: {
    getState: () => ipcRenderer.invoke("updates:getState"),
    download: () => ipcRenderer.invoke("updates:download"),
    install: () => ipcRenderer.invoke("updates:install"),
    dismiss: (request) => ipcRenderer.invoke("updates:dismiss", request),
    onState(callback) {
      const listener = (_event: unknown, snapshot: import("../shared/app-updates").UpdateSnapshot) => callback(snapshot);
      ipcRenderer.on("updates:state", listener);
      return () => ipcRenderer.off("updates:state", listener);
    },
    settings() {
      return ipcRenderer.invoke("updates:settings") as Promise<UpdateSettings>;
    },
    setAutomaticChecks(on) {
      return ipcRenderer.invoke("updates:setAutomaticChecks", on) as Promise<UpdateSettings>;
    },
  },
  /**
   * Both panes talk to main directly rather than through the core's bridge.
   * Main broadcasts on one channel per concern and the id picks this surface's
   * messages out, so a second window listening on the same channel hears only
   * its own shells and its own pane.
   */
  terminal: {
    attach(id) {
      ipcRenderer.send("terminal:attach", id);
    },
    detach(id) {
      ipcRenderer.send("terminal:detach", id);
    },
    open(input) {
      return ipcRenderer.invoke("terminal:open", input) as Promise<{ backlog: string; running: boolean; exitCode: number | null }>;
    },
    write(id, data) {
      ipcRenderer.send("terminal:write", id, data);
    },
    resize(id, cols, rows) {
      ipcRenderer.send("terminal:resize", id, cols, rows);
    },
    kill(id) {
      ipcRenderer.send("terminal:kill", id);
    },
    onData(id, cb) {
      const listener = (_event: unknown, forId: unknown, chunk: unknown) => {
        if (forId === id && typeof chunk === "string") cb(chunk);
      };
      ipcRenderer.on("terminal:data", listener);
      return () => ipcRenderer.off("terminal:data", listener);
    },
    onExit(id, cb) {
      const listener = (_event: unknown, forId: unknown, code: unknown) => {
        if (forId === id) cb(typeof code === "number" ? code : null);
      };
      ipcRenderer.on("terminal:exit", listener);
      return () => ipcRenderer.off("terminal:exit", listener);
    },
    onSettled(cb) {
      const listener = (_event: unknown, id: unknown) => {
        if (typeof id === "string") cb(id);
      };
      ipcRenderer.on("terminal:settled", listener);
      return () => ipcRenderer.off("terminal:settled", listener);
    },
  },
  browser: {
    setContext(id) {
      ipcRenderer.send("browser:context", id);
    },
    onReveal(cb) {
      const listener = (_event: unknown, id: unknown) => {
        if (typeof id === "string") cb(id);
      };
      ipcRenderer.on("browser:reveal", listener);
      return () => ipcRenderer.off("browser:reveal", listener);
    },
    show(input) {
      return ipcRenderer.invoke("browser:show", input) as Promise<BrowserPaneState>;
    },
    setBounds(id, bounds) {
      ipcRenderer.send("browser:setBounds", id, bounds);
    },
    hide(id) {
      ipcRenderer.send("browser:hide", id);
    },
    capture(id) {
      return ipcRenderer.invoke("browser:capture", id) as Promise<string | null>;
    },
    navigate(id, url) {
      ipcRenderer.send("browser:navigate", id, url);
    },
    goBack(id) {
      ipcRenderer.send("browser:goBack", id);
    },
    goForward(id) {
      ipcRenderer.send("browser:goForward", id);
    },
    reload(id) {
      ipcRenderer.send("browser:reload", id);
    },
    close(id) {
      ipcRenderer.send("browser:close", id);
    },
    onState(id, cb) {
      const listener = (_event: unknown, payload: unknown) => {
        if (typeof payload !== "object" || payload === null) return;
        const message = payload as { id?: unknown; state?: BrowserPaneState };
        if (message.id === id && message.state) cb(message.state);
      };
      ipcRenderer.on("browser:state", listener);
      return () => ipcRenderer.off("browser:state", listener);
    },
  },
  autorun: readAutorun(process.env, process.argv, __OPENORC_QA__),
};

contextBridge.exposeInMainWorld("openorc", api);

// MessagePorts cannot cross the context bridge, so forward them to the page
// with a transfer. The renderer listens for the "openorc:port" message.
ipcRenderer.on("bridge:port", (event) => {
  const port = event.ports[0];
  if (port) window.postMessage("openorc:port", "*", [port]);
});
