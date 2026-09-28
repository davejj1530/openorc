import { beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  open: vi.fn().mockReturnValue(true),
  hasContext: vi.fn().mockReturnValue(true),
  external: vi.fn().mockResolvedValue(undefined),
  copy: vi.fn(),
  chrome: vi.fn().mockReturnValue("/chrome"),
  incognito: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("electron", () => ({ clipboard: { writeText: fake.copy }, shell: { openExternal: fake.external } }));
vi.mock("./chrome-incognito", () => ({ chromeExecutable: fake.chrome, openChromeIncognito: fake.incognito }));
vi.mock("./browser-pane", () => ({
  openBrowserLink: fake.open,
  hasBrowserContext: fake.hasContext,
  isAllowedPaneUrl: (url: string) => /^https?:\/\//.test(url) && !url.includes("@"),
}));
import { installLinkNavigation, linkMenuItems } from "./link-navigation";

beforeEach(() => {
  vi.clearAllMocks();
  fake.open.mockReturnValue(true);
  fake.hasContext.mockReturnValue(true);
  fake.chrome.mockReturnValue("/chrome");
});

function host() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const window = {
    webContents: {
      setWindowOpenHandler: (fn: (...args: any[]) => any) => handlers.set("open", fn),
      on: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn),
    },
  } as unknown as Electron.BrowserWindow;
  return { window, handlers };
}

it("offers native sidebar, incognito, external and copy actions", () => {
  const { window } = host();
  const menu = linkMenuItems(window, "https://example.com/docs");
  expect(menu.map((item) => item.label).filter(Boolean)).toEqual(["Open in sidebar", "Open in default browser", "Open in Chrome Incognito", "Copy link address"]);
  for (const item of menu) item.click?.({} as Electron.MenuItem, window, {} as Electron.KeyboardEvent);
  expect(fake.open.mock.calls).toEqual([[window, "https://example.com/docs"]]);
  expect(fake.incognito).toHaveBeenCalledWith("/chrome", "https://example.com/docs");
  expect(fake.external).toHaveBeenCalledWith("https://example.com/docs");
  expect(fake.copy).toHaveBeenCalledWith("https://example.com/docs");
  expect(linkMenuItems(window, "file:///tmp/a")).toEqual([]);
});

it("omits Chrome when unavailable and sidebar actions outside a conversation", () => {
  fake.chrome.mockReturnValue(null);
  fake.hasContext.mockReturnValue(false);
  expect(
    linkMenuItems(host().window, "https://example.com")
      .map((item) => item.label)
      .filter(Boolean),
  ).toEqual(["Open in default browser", "Copy link address"]);
});

it("routes ordinary and new-window links into Preview without navigating the app or opening the OS browser", () => {
  const { window, handlers } = host();
  installLinkNavigation(window, (url) => url.startsWith("file://"));
  expect(handlers.get("open")!({ url: "https://example.com" })).toEqual({ action: "deny" });
  const event = { preventDefault: vi.fn() };
  handlers.get("will-navigate")!(event, "https://example.com/next");
  expect(event.preventDefault).toHaveBeenCalled();
  expect(fake.open).toHaveBeenCalledWith(window, "https://example.com/next");
  expect(fake.external).not.toHaveBeenCalled();
  handlers.get("open")!({ url: "https://user:secret@example.com" });
  expect(fake.open).toHaveBeenCalledTimes(2);
  fake.open.mockReturnValue(false);
  handlers.get("open")!({ url: "https://example.com/outside-thread" });
  expect(fake.external).toHaveBeenCalledWith("https://example.com/outside-thread");
});
