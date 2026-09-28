import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import type { ProjectIconChoice, ProjectIconState } from "../shared/project-icons";
import { createIconPreview } from "./project-icon-images";
import { ProjectIcons } from "./project-icons";

export function installProjectIcons(isAppOrigin: (url: string) => boolean, dataDir: string): void {
  const icons = new ProjectIcons(path.join(dataDir, "project-icons"), createIconPreview);
  const root = (event: IpcMainInvokeEvent, value: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || !isAppOrigin(event.senderFrame.url)) throw new Error("Only the app window can choose project icons.");
    if (typeof value !== "string" || value.length > 4096 || value.includes("\0") || !path.isAbsolute(value)) throw new Error("Invalid project folder.");
    return path.normalize(value);
  };
  const changed = (rootPath: string, state: ProjectIconState) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (isAppOrigin(window.webContents.getURL())) window.webContents.send("project-icons:changed", rootPath, state);
    }
    return state;
  };
  ipcMain.handle("project-icons:get", (event, value: unknown) => icons.get(root(event, value)));
  ipcMain.handle("project-icons:refresh", async (event, value: unknown) => {
    const rootPath = root(event, value);
    return changed(rootPath, await icons.refresh(rootPath));
  });
  ipcMain.handle("project-icons:choose", async (event, value: unknown, choice: unknown) => {
    const rootPath = root(event, value);
    if (!validChoice(choice)) throw new Error("Invalid icon selection.");
    return changed(rootPath, await icons.choose(rootPath, choice));
  });
  ipcMain.handle("project-icons:pick", async (event, value: unknown) => {
    const rootPath = root(event, value);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error("Window unavailable.");
    const result = await dialog.showOpenDialog(window, {
      title: "Choose project icon",
      defaultPath: rootPath,
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "ico", "svg"] }],
    });
    const file = result.filePaths[0];
    if (result.canceled || !file) return null;
    return changed(rootPath, await icons.pick(rootPath, file));
  });
}

function validChoice(value: unknown): value is ProjectIconChoice {
  if (!value || typeof value !== "object") return false;
  const choice = value as { mode?: unknown; path?: unknown };
  if (choice.mode === "auto" || choice.mode === "folder") return true;
  return choice.mode === "manual" && typeof choice.path === "string" && choice.path.length <= 4096;
}
