import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import { runBrowserAction } from "./browser-command";
import { inspectPage, interactWithPage, waitForPage } from "./browser-page";

vi.mock("./browser-page", () => ({ inspectPage: vi.fn(), interactWithPage: vi.fn(), waitForPage: vi.fn() }));
const snapshot = { text: "Page", elements: [], viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 } };
const stop = vi.fn();
const sendCommand = vi.fn();
// A synthetic WebContents supplies only the capability surface the action uses.
const contents = {
  getURL: () => "https://example.test/",
  getTitle: () => "Example",
  isDestroyed: () => false,
  stop,
  debugger: { isAttached: () => true, attach: vi.fn(), sendCommand },
} as unknown as WebContents;
const page = { contents, navigate: vi.fn(), readError: () => null, isAllowedUrl: () => true };

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  vi.mocked(inspectPage).mockResolvedValue(snapshot);
  vi.mocked(interactWithPage).mockResolvedValue(null);
  vi.mocked(waitForPage).mockResolvedValue(undefined);
  sendCommand.mockResolvedValue({ data: "painted-frame" });
});
afterEach(() => vi.useRealTimers());

it("paints before clicking and returns the page after input and navigation settle", async () => {
  const order: string[] = [];
  sendCommand.mockImplementation(async () => {
    order.push("frame");
    return { data: "painted-frame" };
  });
  vi.mocked(interactWithPage).mockImplementation(async () => {
    order.push("click");
    return null;
  });
  vi.mocked(inspectPage).mockImplementation(async () => {
    order.push("snapshot");
    return snapshot;
  });
  expect(await runBrowserAction({ ...page, command: { action: "click", ref: "current:1" } })).toEqual({ url: "https://example.test/", title: "Example", snapshot });
  expect(order).toEqual(["frame", "click", "snapshot"]);
  expect(vi.getTimerCount()).toBe(0);
});

it("returns a password refusal without snapshotting and releases timers on navigation failure", async () => {
  vi.mocked(interactWithPage).mockResolvedValueOnce("password");
  expect(await runBrowserAction({ ...page, command: { action: "fill", ref: "current:1", text: "synthetic" } })).toEqual({ url: "https://example.test/", title: "Example", refused: "password" });
  expect(inspectPage).not.toHaveBeenCalled();
  page.navigate.mockRejectedValueOnce(new Error("Navigation failed"));
  await expect(runBrowserAction({ ...page, command: { action: "open", url: "https://example.test/" } })).rejects.toThrow("Navigation failed");
  expect(vi.getTimerCount()).toBe(0);
});

it("stops a timed-out load and prevents its late completion from sending input, while a new action succeeds", async () => {
  let loaded!: () => void;
  vi.mocked(waitForPage).mockReturnValueOnce(
    new Promise<void>((resolve) => {
      loaded = resolve;
    }),
  );
  const operation = runBrowserAction({ ...page, command: { action: "click", ref: "current:1" } });
  const rejected = expect(operation).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(30000);
  await rejected;
  expect(stop).toHaveBeenCalledOnce();
  loaded();
  await Promise.resolve();
  expect(interactWithPage).not.toHaveBeenCalled();
  expect(await runBrowserAction({ ...page, command: { action: "snapshot" } })).toMatchObject({ snapshot });
  expect(vi.getTimerCount()).toBe(0);
});
