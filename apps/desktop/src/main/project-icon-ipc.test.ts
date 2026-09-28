import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, expect, it, vi } from "vitest";
import { installProjectIcons } from "./project-icon-ipc";

const fake = vi.hoisted(() => ({ handle: vi.fn(), get: vi.fn(), refresh: vi.fn(), choose: vi.fn(), pick: vi.fn(), dialog: vi.fn(), send: vi.fn() }));
vi.mock("electron", () => ({
  ipcMain: { handle: fake.handle },
  BrowserWindow: { fromWebContents: () => ({}), getAllWindows: () => [{ webContents: { getURL: () => "https://app.test/", send: fake.send } }] },
  dialog: { showOpenDialog: fake.dialog },
}));
vi.mock("./project-icon-images", () => ({ createIconPreview: vi.fn() }));
vi.mock("./project-icons", () => ({
  ProjectIcons: class {
    get = fake.get;
    refresh = fake.refresh;
    choose = fake.choose;
    pick = fake.pick;
  },
}));
const state = { mode: "folder", selected: null, candidates: [], fallback: null };
beforeEach(() => {
  vi.clearAllMocks();
  fake.refresh.mockResolvedValue(state);
  fake.pick.mockResolvedValue(state);
  installProjectIcons((url) => url === "https://app.test/", "/data");
});
function handler(name: string) {
  return fake.handle.mock.calls.find((call) => call[0] === `project-icons:${name}`)![1] as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
}
function event(url = "https://app.test/"): IpcMainInvokeEvent {
  const frame = { url };
  return { senderFrame: frame, sender: { mainFrame: frame } } as unknown as IpcMainInvokeEvent;
}

it("accepts only the app's main frame and validates folders and selections", async () => {
  const get = handler("get");
  expect(() => get(event("https://other.test/"), "/repo")).toThrow("Only the app window");
  const child = event();
  expect(() => get({ ...child, senderFrame: { url: "https://app.test/" } } as IpcMainInvokeEvent, "/repo")).toThrow("Only the app window");
  for (const root of [null, {}, "relative/path", "/repo\0secret"]) expect(() => get(event(), root)).toThrow("Invalid project folder");
  await expect(handler("choose")(event(), "/repo", { mode: "manual", path: 42 })).rejects.toThrow("Invalid icon selection");
  expect(fake.get).not.toHaveBeenCalled();
});

it("broadcasts successful changes and never imports a cancelled file selection", async () => {
  await handler("refresh")(event(), "/repo");
  expect(fake.send).toHaveBeenCalledWith("project-icons:changed", "/repo", state);
  fake.dialog.mockResolvedValue({ canceled: true, filePaths: [] });
  expect(await handler("pick")(event(), "/repo")).toBeNull();
  expect(fake.pick).not.toHaveBeenCalled();
  fake.dialog.mockResolvedValue({ canceled: false, filePaths: ["/chosen/icon.png"] });
  await handler("pick")(event(), "/repo");
  expect(fake.pick).toHaveBeenCalledWith("/repo", "/chosen/icon.png");
});
