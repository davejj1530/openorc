import { BrowserWindow, ipcMain, Notification, type IpcMainInvokeEvent } from "electron";
import type { UpdateSettings } from "../shared/types";
import { isUpdateDismissal } from "../shared/app-updates";
import type { AppUpdates } from "./app-updates";
import { UpdateNotices } from "./update-notices";
import { UpdatePreferences } from "./update-preferences";

/** The updater stays in main; only trusted app frames can read it or request an action. */
export function installUpdateControls(updates: AppUpdates, file: string, isAppOrigin: (url: string) => boolean, createWindow: () => BrowserWindow): () => void {
  const preferences = new UpdatePreferences(file);
  const windows = () => BrowserWindow.getAllWindows().filter((win) => isAppOrigin(win.webContents.getURL()));
  const trusted = (event: IpcMainInvokeEvent) => {
    if (event.senderFrame !== event.sender.mainFrame || !isAppOrigin(event.senderFrame.url)) throw new Error("Only the app window can control updates.");
  };
  let notification: Notification | undefined;
  const notices = new UpdateNotices(
    updates,
    preferences,
    {
      foreground: () => windows().some((win) => win.isFocused() && win.isVisible() && !win.isMinimized()),
      notify(version, reveal) {
        if (!Notification.isSupported()) return;
        notification?.close();
        notification = new Notification({ title: "OpenOrc update available", body: `OpenOrc ${version} is available. Open the app to download it.`, silent: true });
        notification.on("click", reveal);
        notification.on("failed", (_event, error) => console.warn("Could not show update notification", error));
        notification.show();
      },
      reveal() {
        const win = windows()[0] ?? createWindow();
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      },
    },
    (snapshot) => {
      for (const win of windows()) win.webContents.send("updates:state", snapshot);
    },
  );
  const settings = (): UpdateSettings => ({ automaticChecks: preferences.automaticChecks(), unavailable: updates.state.phase === "disabled" ? updates.state.reason : null });
  const handlers = {
    "updates:settings": () => settings(),
    "updates:setAutomaticChecks": (on: unknown) => {
      if (typeof on !== "boolean") throw new Error("Automatic update checks are on or off.");
      preferences.setAutomaticChecks(on);
      updates.setAutomaticChecks(on);
      return settings();
    },
    "updates:getState": () => notices.snapshot,
    "updates:dismiss": (request: unknown) => {
      if (!isUpdateDismissal(request)) throw new Error("Invalid update dismissal.");
      return notices.dismiss(request);
    },
    "updates:download": () => updates.download(),
    "updates:install": () => updates.install(),
  };
  for (const [channel, handle] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, input: unknown) => {
      trusted(event);
      return handle(input);
    });
  }
  updates.setAutomaticChecks(preferences.automaticChecks());
  return () => {
    notices.dispose();
    notification?.close();
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel);
  };
}
