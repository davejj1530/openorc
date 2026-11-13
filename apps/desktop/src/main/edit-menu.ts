import { BrowserWindow, webContents, type MenuItemConstructorOptions } from "electron";

/** The channel the app's window hears Edit > Undo and Edit > Redo on. */
export const EDIT_HISTORY_CHANNEL = "edit:history";

export type EditHistoryAction = "undo" | "redo";

/**
 * Undo or Redo from the menu bar. Electron's own roles ask the page's browser history, which is empty in a field that
 * keeps its own (the composer's editor), so Redo there did nothing. The app's window is told instead and decides
 * itself; anything else focused (a Preview page, another window's web page) gets the browser's own, as the roles do.
 */
function editHistory(action: EditHistoryAction) {
  const focused = webContents.getFocusedWebContents();
  if (!focused || focused.isDestroyed()) return;
  const window = BrowserWindow.fromWebContents(focused);
  if (window && window.webContents === focused) focused.send(EDIT_HISTORY_CHANNEL, action);
  else focused[action]();
}

/** The Edit menu as Electron's role draws it, with Undo and Redo reaching the app's own fields. */
export function appEditMenu(): MenuItemConstructorOptions {
  const mac = process.platform === "darwin";
  const history: MenuItemConstructorOptions[] = [
    { id: "edit-undo", label: "Undo", accelerator: "CommandOrControl+Z", click: () => editHistory("undo") },
    { id: "edit-redo", label: "Redo", accelerator: mac ? "Shift+CommandOrControl+Z" : "Control+Y", click: () => editHistory("redo") },
  ];
  return {
    label: "Edit",
    submenu: mac
      ? [
          ...history,
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "pasteAndMatchStyle" },
          { role: "delete" },
          { role: "selectAll" },
          { type: "separator" },
          { label: "Speech", submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }] },
        ]
      : [...history, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "delete" }, { type: "separator" }, { role: "selectAll" }],
  };
}
