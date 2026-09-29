import { release } from "node:os";
import { BrowserWindow, ipcMain, nativeTheme } from "electron";
import type { WindowAppearance, WindowAppearanceResult } from "../shared/types";

function validAppearance(value: unknown): value is WindowAppearance {
  if (!value || typeof value !== "object") return false;
  const appearance = value as Partial<WindowAppearance>;
  return (
    ["system", "light", "dark"].includes(appearance.theme ?? "") &&
    typeof appearance.transparent === "boolean" &&
    typeof appearance.background === "string" &&
    /^#[0-9a-f]{6}$/i.test(appearance.background)
  );
}

export function applyWindowAppearance(win: BrowserWindow, appearance: WindowAppearance): WindowAppearanceResult {
  // Acrylic requires Windows 11 22H2. Unsupported platforms keep their opaque shell.
  const supported = process.platform === "darwin" || (process.platform === "win32" && Number(release().split(".")[2]) >= 22621);
  nativeTheme.themeSource = appearance.theme;
  const reducedTransparency = nativeTheme.prefersReducedTransparency;
  const enabled = supported && appearance.transparent && !reducedTransparency;
  if (process.platform === "darwin") win.setVibrancy(enabled ? "under-window" : null);
  if (process.platform === "win32" && supported) win.setBackgroundMaterial(enabled ? "acrylic" : "none");
  win.setBackgroundColor(enabled ? "#00000000" : appearance.background);
  // Windows and Linux draw their controls over the header, so their symbols follow its theme.
  if (process.platform !== "darwin") {
    win.setTitleBarOverlay({ symbolColor: nativeTheme.shouldUseDarkColors ? "#e6e6e6" : "#282828" });
  }
  return { supported, enabled, reducedTransparency };
}

export function installWindowAppearance(isAppOrigin: (url: string) => boolean): void {
  ipcMain.handle("window:appearance", (event, appearance: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || !isAppOrigin(event.senderFrame.url)) throw new Error("Only the app window can change its appearance.");
    if (!validAppearance(appearance)) throw new Error("Invalid window appearance.");
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) throw new Error("Window unavailable.");
    return applyWindowAppearance(win, appearance);
  });
}
