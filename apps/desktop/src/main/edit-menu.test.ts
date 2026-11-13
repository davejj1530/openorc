import type { MenuItemConstructorOptions } from "electron";
import { expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ focused: null as unknown, windowOf: vi.fn() }));
vi.mock("electron", () => ({
  webContents: { getFocusedWebContents: () => native.focused },
  BrowserWindow: { fromWebContents: native.windowOf },
}));

const { appEditMenu, EDIT_HISTORY_CHANNEL } = await import("./edit-menu");

const item = (id: string) => (appEditMenu().submenu as MenuItemConstructorOptions[]).find((each) => each.id === id)!;
const press = (id: string) => (item(id).click as () => void)();
const page = () => ({ isDestroyed: () => false, send: vi.fn(), undo: vi.fn(), redo: vi.fn() });

it("tells the app's window to undo or redo, where its own fields keep their history", () => {
  const app = page();
  native.focused = app;
  native.windowOf.mockReturnValue({ webContents: app });
  press("edit-undo");
  press("edit-redo");
  expect(app.send.mock.calls).toEqual([
    [EDIT_HISTORY_CHANNEL, "undo"],
    [EDIT_HISTORY_CHANNEL, "redo"],
  ]);
  expect(app.undo).not.toHaveBeenCalled();
});

it("gives any other focused page the browser's own undo and redo, as the roles did", () => {
  const preview = page();
  native.focused = preview;
  native.windowOf.mockReturnValue({ webContents: page() });
  press("edit-undo");
  press("edit-redo");
  expect(preview.undo).toHaveBeenCalledOnce();
  expect(preview.redo).toHaveBeenCalledOnce();
  expect(preview.send).not.toHaveBeenCalled();
});

it("keeps the keys a text field answers to", () => {
  expect(item("edit-undo").accelerator).toBe("CommandOrControl+Z");
  expect(["Shift+CommandOrControl+Z", "Control+Y"]).toContain(item("edit-redo").accelerator);
});
