import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: fake.spawn }));
import { openChromeIncognito } from "./chrome-incognito";

it("opens Chrome incognito with a separate literal URL argument and no shell", async () => {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  fake.spawn.mockReturnValue(child);
  const url = "https://example.com/?q=$(touch%20/tmp/nope)&x=a;b";
  const opening = openChromeIncognito("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", url);
  child.emit("spawn");
  await opening;
  expect(fake.spawn).toHaveBeenCalledWith("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--incognito", "--new-window", url], { detached: true, stdio: "ignore", shell: false });
  expect(child.unref).toHaveBeenCalledOnce();
});

it("reports a launch failure without falling back to a regular browser", async () => {
  const child = new EventEmitter();
  fake.spawn.mockReturnValue(child);
  const opening = openChromeIncognito("/missing/chrome", "https://example.com");
  child.emit("error", new Error("Chrome was removed"));
  await expect(opening).rejects.toThrow("Chrome was removed");
});
