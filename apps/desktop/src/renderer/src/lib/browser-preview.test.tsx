import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useBrowserPreview } from "./browser-preview";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("reveals only the selected conversation and releases its subscription on switches", () => {
  const listeners = new Set<(id: string) => void>();
  const setContext = vi.fn();
  vi.stubGlobal("openorc", {
    browser: {
      setContext,
      onReveal: (cb: (id: string) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    },
  });
  const reveal = vi.fn();
  const hook = renderHook(({ id }) => useBrowserPreview(id, reveal), { initialProps: { id: "thread:a" } });
  expect(setContext).toHaveBeenLastCalledWith("thread:a");
  for (const cb of listeners) cb("thread:b");
  expect(reveal).not.toHaveBeenCalled();
  for (const cb of listeners) cb("thread:a");
  expect(reveal).toHaveBeenCalledTimes(1);
  hook.rerender({ id: "thread:b" });
  expect(listeners.size).toBe(1);
  expect(setContext.mock.calls.map(([id]) => id)).toEqual(["thread:a", null, "thread:b"]);
  for (const cb of listeners) cb("thread:a");
  expect(reveal).toHaveBeenCalledTimes(1);
  for (const cb of listeners) cb("thread:b");
  expect(reveal).toHaveBeenCalledTimes(2);
  hook.unmount();
  expect(listeners.size).toBe(0);
  expect(setContext).toHaveBeenLastCalledWith(null);
});
