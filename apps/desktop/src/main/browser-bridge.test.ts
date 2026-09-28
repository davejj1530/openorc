import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { installBrowserBridge } from "./browser-bridge";

it("validates the private channel and refuses overlapping actions on the same conversation", async () => {
  const child = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
  let release!: () => void;
  const execute = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { url: "http://localhost", title: "Done" };
  });
  installBrowserBridge(child, execute);
  child.emit("message", { type: "browser.command", id: 1, surface: "thread:a", command: { action: "snapshot" } });
  child.emit("message", { type: "browser.command", id: 2, surface: "thread:a", command: { action: "snapshot" } });
  child.emit("message", { type: "browser.command", id: 3, surface: "app:main", command: { action: "snapshot" } });
  child.emit("message", { type: "browser.command", id: 4, surface: "thread:a", command: { action: "eval", code: "bad" } });
  await Promise.resolve();
  expect(execute).toHaveBeenCalledExactlyOnceWith("thread:a", { action: "snapshot" });
  expect(child.postMessage.mock.calls.map(([reply]) => reply)).toEqual([
    expect.objectContaining({ id: 2, error: expect.stringContaining("Another browser action") }),
    expect.objectContaining({ id: 3, error: "Invalid sidebar browser command." }),
    expect.objectContaining({ id: 4, error: "Invalid sidebar browser command." }),
  ]);
  release();
  await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledWith({ type: "browser.result", id: 1, result: { url: "http://localhost", title: "Done" } }));
});
