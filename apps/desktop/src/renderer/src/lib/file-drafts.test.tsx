import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileVersion } from "@openorc/protocol";

const draft = { text: "mine", base: FileVersion.parse("a".repeat(64)) };
const newer = { text: "mine, more", base: draft.base };

/** A fresh copy of the module, as after a restart. */
async function boot() {
  vi.resetModules();
  const drafts = await import("./file-drafts");
  await vi.waitFor(() => expect(drafts.useDrafts.getState().ready).toBe(true));
  return { ...drafts, key: drafts.fileKey({ root: "/repo", path: "src/cart.ts" }) };
}

/** What the device holds for a key, read through a connection of its own. */
function stored(key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("openorc-file-drafts", 1);
    open.onsuccess = () => {
      const get = open.result.transaction("drafts").objectStore("drafts").get(key);
      get.onsuccess = () => {
        open.result.close();
        resolve(get.result);
      };
      get.onerror = () => reject(get.error);
    };
    open.onerror = () => reject(open.error);
  });
}

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps a draft across a restart, and knows the file has one before reading it", async () => {
  const first = await boot();
  first.putDraft(first.key, draft);
  await first.flushDrafts();
  const second = await boot();
  expect(second.useDrafts.getState().keys.has(second.key)).toBe(true);
  expect(await second.loadDraft(second.key)).toEqual(draft);
});

it.each(["pagehide", "blur", "visibilitychange"])("writes typing at once on %s instead of waiting for the pause", async (event) => {
  const drafts = await boot();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  drafts.putDraft(drafts.key, draft);
  (event === "visibilitychange" ? document : window).dispatchEvent(new Event(event));
  expect(await stored(drafts.key)).toEqual(draft);
});

it("flags a write the device refused, and retries it with the next one", async () => {
  const drafts = await boot();
  const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
    throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
  });
  drafts.putDraft(drafts.key, draft);
  await drafts.flushDrafts();
  expect(drafts.useDrafts.getState().failed).toBe(true);
  put.mockRestore();
  await drafts.flushDrafts();
  expect(drafts.useDrafts.getState().failed).toBe(false);
  expect(await stored(drafts.key)).toEqual(draft);
});

it("keeps typing that lands while the stored draft is still being read", async () => {
  const first = await boot();
  first.putDraft(first.key, draft);
  await first.flushDrafts();
  const second = await boot();
  const reading = second.loadDraft(second.key);
  second.putDraft(second.key, newer);
  expect(await reading).toEqual(newer);
  expect(second.useDrafts.getState().loaded.get(second.key)).toEqual(newer);
});

it("doesn't bring back a draft dropped before the startup read finished", async () => {
  const first = await boot();
  first.putDraft(first.key, draft);
  await first.flushDrafts();
  vi.resetModules();
  const second = await import("./file-drafts");
  const key = second.fileKey({ root: "/repo", path: "src/cart.ts" });
  second.putDraft(key, null);
  await vi.waitFor(() => expect(second.useDrafts.getState().ready).toBe(true));
  expect(second.useDrafts.getState().keys.has(key)).toBe(false);
});
