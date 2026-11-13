import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";

vi.mock("electron", () => ({ shell: { openExternal: vi.fn() } }));

const { installOpenBrowser } = await import("./open-browser-ipc");

it("opens the web pages the core asks for and nothing else", () => {
  const child = new EventEmitter();
  const open = vi.fn(async () => undefined);
  installOpenBrowser(child, open);
  child.emit("message", { type: "open-browser", url: "https://github.com/login/oauth/authorize?state=s" });
  child.emit("message", { type: "open-browser", url: "file:///Applications/Calculator.app" });
  child.emit("message", { type: "trash", url: "https://example.com" });
  expect(open.mock.calls).toEqual([["https://github.com/login/oauth/authorize?state=s"]]);
});
