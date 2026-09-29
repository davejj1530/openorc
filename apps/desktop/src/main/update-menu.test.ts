import { EventEmitter } from "node:events";
import type { MenuItemConstructorOptions } from "electron";
import type { AppUpdater, UpdateCheckResult } from "electron-updater";
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
  vi.useRealTimers();
});

function fixture() {
  const info = { version: "0.2.0", files: [], releaseDate: "2026-09-29", path: "app.zip", sha512: "fixture" };
  const updater = Object.assign(new EventEmitter(), {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: true,
    allowDowngrade: false,
    requestHeaders: null,
    checkForUpdates: vi.fn<AppUpdater["checkForUpdates"]>(async () => ({ isUpdateAvailable: true, updateInfo: info, versionInfo: info })),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
  });
  const updates = new AppUpdates(updater, null, async () => null);
  const off = installUpdateMenu(updates);
  cleanup.push(() => {
    off();
    updates.dispose();
  });
  const open = () => (updateItem(native.template)!.click as () => void)();
  return { updater, updates, open, available: { isUpdateAvailable: true, updateInfo: info, versionInfo: info } };
}

it("downloads the known release from the native menu without another feed check", async () => {
  const { updater, updates, open } = fixture();
  await updates.check();
  expect(native.item.label).toBe("Download OpenOrc 0.2.0…");
  updater.checkForUpdates.mockRejectedValueOnce(new Error("offline"));
  native.show.mockResolvedValueOnce({ response: 0 }).mockResolvedValue({ response: 1 });
  open();
  await vi.waitFor(() => expect(updater.downloadUpdate).toHaveBeenCalledOnce());
  expect(updater.checkForUpdates).toHaveBeenCalledOnce();
  expect(native.item.label).toBe("Restart to install OpenOrc 0.2.0…");
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
});

it("honors Download confirmed in the native dialog while an automatic recheck is outstanding", async () => {
  vi.useFakeTimers();
  const { updater, updates, open, available } = fixture();
  updates.setAutomaticChecks(true);
  await vi.advanceTimersByTimeAsync(30_000);
  let confirm!: (answer: { response: number }) => void;
  native.show
    .mockReturnValueOnce(
      new Promise((resolve) => {
        confirm = resolve;
      }),
    )
    .mockResolvedValue({ response: 1 });
  open();
  expect(native.show).toHaveBeenCalledWith(expect.objectContaining({ buttons: ["Download update", "Later"] }));
  let checked!: (result: UpdateCheckResult) => void;
  updater.checkForUpdates.mockReturnValueOnce(
    new Promise((resolve) => {
      checked = resolve;
    }),
  );
  await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000 - 30_000);
  expect(updates.state.phase).toBe("checking");
  confirm({ response: 0 });
  await vi.advanceTimersByTimeAsync(0);
  expect(updater.downloadUpdate).not.toHaveBeenCalled();
  checked(available);
  await vi.advanceTimersByTimeAsync(0);
  expect(updater.downloadUpdate).toHaveBeenCalledOnce();
  expect(updates.state).toEqual({ phase: "ready", version: "0.2.0" });
  expect(native.show).toHaveBeenLastCalledWith(expect.objectContaining({ message: "OpenOrc 0.2.0 is ready" }));
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
});
