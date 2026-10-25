import { expect, it } from "vitest";
import { frameStep, loadGuard, readFrameMessage, type FrameState } from "./visualization-frame";

const json = (value: unknown) => JSON.stringify(value);

it("reads the page's three notices", () => {
  expect(readFrameMessage(json({ jsonrpc: "2.0", method: "ui/notifications/initialized" }))).toEqual({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
  expect(readFrameMessage(json({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 440 } }))).toMatchObject({ params: { height: 440 } });
  expect(readFrameMessage(json({ jsonrpc: "2.0", method: "openorc/visualization-error", params: { message: "Bad step" } }))).toMatchObject({ params: { message: "Bad step" } });
});

it.each([
  ["text that is not JSON", "hello"],
  ["a bare value", "42"],
  ["no protocol version", json({ method: "ui/notifications/initialized" })],
  ["a method the phone does not take", json({ jsonrpc: "2.0", method: "tools/call", params: { name: "approvals.resolve" } })],
  ["the desktop proxy's notice", json({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready" })],
  ["a height that is not finite", '{"jsonrpc":"2.0","method":"ui/notifications/size-changed","params":{"height":1e999}}'],
  ["a height that is not a number", json({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: "9999" } })],
  ["an error longer than the page may send", json({ jsonrpc: "2.0", method: "openorc/visualization-error", params: { message: "x".repeat(501) } })],
])("ignores %s", (_, data) => {
  expect(readFrameMessage(data)).toBeNull();
});

it("is ready once the page is up, even after a slow start timed out, and fails with what the page said", () => {
  const up = { jsonrpc: "2.0", method: "ui/notifications/initialized" } as const;
  const failed = { jsonrpc: "2.0", method: "openorc/visualization-error", params: { message: "Bad step" } } as const;
  const size = { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 300 } } as const;
  const loading: FrameState = { kind: "loading" };
  expect(frameStep(loading, up)).toEqual({ kind: "ready" });
  expect(frameStep({ kind: "error", message: "timed out" }, up)).toEqual({ kind: "ready" });
  expect(frameStep({ kind: "ready" }, failed)).toEqual({ kind: "error", message: "Bad step" });
  expect(frameStep(loading, size)).toBe(loading);
});

it("lets the web view load its own page once and nothing after it", () => {
  const guard = loadGuard();
  expect(guard({ url: "https://example.com/", isTopFrame: true })).toBe(false);
  expect(guard({ url: "about:blank", isTopFrame: false })).toBe(false);
  expect(guard({ url: "about:blank", isTopFrame: true })).toBe(true);
  for (const url of ["about:blank", "https://example.com/", "openorc://pair#v1.x", "tel:123", "data:text/html,<p>x</p>", "file:///etc/hosts"]) {
    expect(guard({ url, isTopFrame: true })).toBe(false);
    expect(guard({ url, isTopFrame: false })).toBe(false);
  }
  expect(loadGuard()({ url: "about:blank", isTopFrame: true })).toBe(true);
});
