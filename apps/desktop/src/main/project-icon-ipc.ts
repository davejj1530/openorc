import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import type { ProjectIconChoice, ProjectIconState } from "../shared/project-icons";
import { createIconPreview } from "./project-icon-images";
import { ProjectIcons } from "./project-icons";

/**
 * A project's folder as main reads it, and the path the window knows the project by. On this computer both are the
 * normalized path. A core inside a WSL distribution names the project by its Linux path, which stays the window's name
 * for it while main reads the folder through the share Windows mounts.
 */
export type ProjectFolder = (rootPath: string) => { folder: string; shown: string };
const onThisComputer: ProjectFolder = (rootPath) => ({ folder: path.normalize(rootPath), shown: path.normalize(rootPath) });

export function installProjectIcons(isAppOrigin: (url: string) => boolean, dataDir: string, place: ProjectFolder = onThisComputer): void {
  const icons = new ProjectIcons(path.join(dataDir, "project-icons"), createIconPreview);
  const root = (event: IpcMainInvokeEvent, value: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || !isAppOrigin(event.senderFrame.url)) throw new Error("Only the app window can choose project icons.");
    if (typeof value !== "string" || value.length > 4096 || value.includes("\0") || !path.isAbsolute(value)) throw new Error("Invalid project folder.");
    return place(value);
  };
  const changed = (rootPath: string, state: ProjectIconState) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (isAppOrigin(window.webContents.getURL())) window.webContents.send("project-icons:changed", rootPath, state);
    }
    return state;
  };
  ipcMain.handle("project-icons:get", (event, value: unknown) => icons.get(root(event, value).folder));
  ipcMain.handle("project-icons:refresh", async (event, value: unknown) => {
    const { folder, shown } = root(event, value);
    return changed(shown, await icons.refresh(folder));
  });
  ipcMain.handle("project-icons:choose", async (event, value: unknown, choice: unknown) => {
    const { folder, shown } = root(event, value);
    if (!validChoice(choice)) throw new Error("Invalid icon selection.");
    return changed(shown, await icons.choose(folder, choice));
  });
  ipcMain.handle("project-icons:pick", async (event, value: unknown) => {
    const { folder, shown } = root(event, value);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error("Window unavailable.");
    const result = await dialog.showOpenDialog(window, {
      title: "Choose project icon",
      defaultPath: folder,
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "ico", "svg"] }],
    });
    const file = result.filePaths[0];
    if (result.canceled || !file) return null;
    return changed(shown, await icons.pick(folder, file));
  });
}

function validChoice(value: unknown): value is ProjectIconChoice {
  if (!value || typeof value !== "object") return false;
  const choice = value as { mode?: unknown; path?: unknown };
  if (choice.mode === "auto" || choice.mode === "folder") return true;
  return choice.mode === "manual" && typeof choice.path === "string" && choice.path.length <= 4096;
}
