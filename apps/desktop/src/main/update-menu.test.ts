import { EventEmitter } from "node:events";
import type { MenuItemConstructorOptions } from "electron";
import { afterEach, expect, it, vi } from "vitest";
import { AppUpdates } from "./app-updates";
import { installUpdateMenu } from "./update-menu";

const native = vi.hoisted(() => ({
  template: [] as MenuItemConstructorOptions[],
  item: { label: "", enabled: true },
  show: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { getVersion: () => "0.1.0" },
  dialog: { showMessageBox: native.show },
  Menu: {
    buildFromTemplate(template: MenuItemConstructorOptions[]) {
      native.template = template;
      return { getMenuItemById: () => native.item };
    },
    setApplicationMenu: vi.fn(),
  },
}));

function updateItem(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions | undefined {
  for (const item of items) {
    if (item.id === "app-update") return item;
    const nested = Array.isArray(item.submenu) ? updateItem(item.submenu) : undefined;
    if (nested) return nested;
  }
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
  vi.resetAllMocks();
});

it("downloads the known release from the native menu without another feed check", async () => {
  const info = { version: "0.2.0", files: [], releaseDate: "2026-09-29", path: "app.zip", sha512: "fixture" };
  const updater = Object.assign(new EventEmitter(), {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: true,
    allowDowngrade: false,
    requestHeaders: null,
    checkForUpdates: vi.fn(async () => ({ isUpdateAvailable: true, updateInfo: info, versionInfo: info })),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
  });
  const updates = new AppUpdates(updater, null, async () => null);
  const off = installUpdateMenu(updates);
  cleanup.push(() => {
    off();
    updates.dispose();
  });
  await updates.check();
  expect(native.item.label).toBe("Download OpenOrc 0.2.0…");
  updater.checkForUpdates.mockRejectedValueOnce(new Error("offline"));
  native.show.mockResolvedValueOnce({ response: 0 }).mockResolvedValue({ response: 1 });
  const item = updateItem(native.template)!;
  (item.click as () => void)();
  await vi.waitFor(() => expect(updater.downloadUpdate).toHaveBeenCalledOnce());
  expect(updater.checkForUpdates).toHaveBeenCalledOnce();
  expect(native.item.label).toBe("Restart to install OpenOrc 0.2.0…");
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
});
