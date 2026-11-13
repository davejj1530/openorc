import { afterEach, expect, it, vi } from "vitest";
import { acpControl } from "./control.js";

afterEach(() => vi.useRealTimers());

it("closes a stalled control connection and returns a retryable error", async () => {
  vi.useFakeTimers();
  const close = vi.fn();
  const pending = acpControl("Agent", () => new Promise(() => {}), close);
  const result = expect(pending).rejects.toThrow("within 60 seconds");
  await vi.advanceTimersByTimeAsync(60_000);
  await result;
  expect(close).toHaveBeenCalledOnce();
});

it("clears the deadline after a response without closing the live session", async () => {
  vi.useFakeTimers();
  const close = vi.fn();
  await expect(acpControl("Agent", async () => "ready", close)).resolves.toBe("ready");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(close).not.toHaveBeenCalled();
});
