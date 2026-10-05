import { BrowserWindow, type MenuItemConstructorOptions } from "electron";

function zoomControl(direction: "in" | "out" | "reset", label: string, accelerator: string): MenuItemConstructorOptions {
  return {
    id: `app-zoom-${direction}`,
    label,
    accelerator,
    click: (_item, focusedWindow) => {
      const window = focusedWindow ? BrowserWindow.fromId(focusedWindow.id) : BrowserWindow.getFocusedWindow();
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
      const contents = window.webContents;
      // Electron's zoom roles follow the focused WebContents, which can be Preview.
      // These are app controls, so zoom the owning window's renderer instead.
      const step = direction === "in" ? 0.5 : -0.5;
      const factor = direction === "reset" ? 1 : Math.max(0.5, Math.min(3, contents.getZoomFactor() * 1.2 ** step));
      contents.setZoomFactor(factor);
    },
  };
}

export function appViewMenu(): MenuItemConstructorOptions {
  return {
    role: "viewMenu",
    submenu: [
      { role: "reload" },
      { role: "forceReload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      zoomControl("reset", "Actual Size", "CommandOrControl+0"),
      zoomControl("in", "Zoom In", "CommandOrControl+Plus"),
      zoomControl("out", "Zoom Out", "CommandOrControl+-"),
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };
}
