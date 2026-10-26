import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Device } from "@openorc/protocol";
import type { DeviceTransport } from "../../lib/device/stream";
import { DeviceStage } from "./DeviceStage";

const device: Device = { id: "UDID-1", name: "iPhone 17", platform: "ios", os: "iOS 26.5", formFactor: "phone", state: "booted" };

function fakeTransport() {
  return { start: vi.fn(), stop: vi.fn(), touch: vi.fn(), key: vi.fn(), paste: vi.fn(), press: vi.fn() } satisfies DeviceTransport;
}

beforeEach(() => {
  // jsdom has neither pointer events nor pointer capture; Chromium has both.
  if (!("setPointerCapture" in HTMLElement.prototype)) Object.assign(HTMLElement.prototype, { setPointerCapture() {} });
  if (typeof PointerEvent === "undefined")
    vi.stubGlobal(
      "PointerEvent",
      class extends MouseEvent {
        readonly pointerId: number;
        constructor(type: string, init: PointerEventInit = {}) {
          super(type, init);
          this.pointerId = init.pointerId ?? 0;
        }
      },
    );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(transport: DeviceTransport, phase: "streaming" | "starting" = "streaming") {
  render(<DeviceStage device={device} phase={{ kind: phase }} view={{ status: { kind: "streaming" }, screen: null, input: true }} transport={transport} canvasRef={() => {}} onStart={() => {}} />);
  return screen.getByRole("application", { name: "iPhone 17 screen" });
}

const keys = (transport: ReturnType<typeof fakeTransport>) => transport.key.mock.calls.map(([event, phase]) => `${(event as { code: string }).code} ${phase}`);

it("releases a key on the device even when Command is held by the time it comes up", () => {
  const transport = fakeTransport();
  const frame = mount(transport);
  fireEvent.keyDown(frame, { code: "KeyA", key: "a" });
  fireEvent.keyDown(frame, { code: "MetaLeft", key: "Meta", metaKey: true });
  fireEvent.keyUp(frame, { code: "KeyA", key: "a", metaKey: true });
  fireEvent.keyUp(frame, { code: "MetaLeft", key: "Meta" });
  expect(keys(transport)).toEqual(["KeyA down", "KeyA up"]);
});

it("releases held keys when the screen loses focus, and leaves Tab and app shortcuts to the app", () => {
  const transport = fakeTransport();
  const frame = mount(transport);
  fireEvent.keyDown(frame, { code: "ShiftLeft", key: "Shift" });
  fireEvent.keyDown(frame, { code: "Tab", key: "Tab" });
  fireEvent.keyDown(frame, { code: "KeyW", key: "w", metaKey: true });
  fireEvent.blur(frame);
  expect(keys(transport)).toEqual(["ShiftLeft down", "ShiftLeft up"]);
});

it("turns click and drag into one touch, and takes no input before the screen streams", () => {
  const transport = fakeTransport();
  const frame = mount(transport);
  fireEvent.pointerDown(frame, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
  fireEvent.pointerMove(frame, { pointerId: 1, clientX: 0, clientY: 0 });
  fireEvent.pointerUp(frame, { pointerId: 1, clientX: 0, clientY: 0 });
  expect(transport.touch.mock.calls.map(([phase]) => phase)).toEqual(["begin", "move", "end"]);
  cleanup();
  const idle = fakeTransport();
  const starting = mount(idle, "starting");
  fireEvent.pointerDown(starting, { button: 0, pointerId: 1 });
  fireEvent.keyDown(starting, { code: "KeyA", key: "a" });
  expect(idle.touch).not.toHaveBeenCalled();
  expect(idle.key).not.toHaveBeenCalled();
});
