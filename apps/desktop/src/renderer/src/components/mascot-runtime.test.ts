// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventType, type RiveParameters } from "@rive-app/canvas";

const renderer = vi.hoisted(() => ({
  options: undefined as RiveParameters | undefined,
  expression: { value: 0 },
  cleanup: vi.fn(),
  play: vi.fn(),
  pause: vi.fn(),
  startRendering: vi.fn(),
  stopRendering: vi.fn(),
  resize: vi.fn(),
  bodyColor: { rgb: vi.fn() },
  eyeColor: { rgb: vi.fn() },
}));
vi.mock("../lib/color", () => ({ toHex: (value: string) => (/^#[0-9a-f]{6}$/i.test(value) ? value : null) }));
vi.mock("@rive-app/canvas", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rive-app/canvas")>();
  return {
    ...actual,
    RuntimeLoader: { setWasmUrl: vi.fn(), setWasmFallbackUrl: vi.fn() },
    Rive: class {
      constructor(options: RiveParameters) {
        renderer.options = options;
      }
      viewModelInstance = { number: () => renderer.expression, color: (name: string) => (name === "bodyColor" ? renderer.bodyColor : renderer.eyeColor) };
      cleanup = renderer.cleanup;
      play = renderer.play;
      pause = renderer.pause;
      startRendering = renderer.startRendering;
      stopRendering = renderer.stopRendering;
      resizeDrawingSurfaceToCanvas = renderer.resize;
    },
  };
});
import { createMascotAnimation } from "./mascot-runtime";

const paint = () => renderer.options!.onAdvance!({ type: EventType.Advance });
const load = () => renderer.options!.onLoad!({ type: EventType.Load });

describe("Rive mascot reactions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    renderer.expression.value = 0;
  });
  afterEach(() => vi.useRealTimers());
  function setup() {
    const failed = vi.fn();
    const ready = vi.fn();
    const canvas = document.createElement("canvas");
    const mascot = createMascotAnimation({ canvas, onReady: ready, onError: failed });
    return { mascot, failed, ready, canvas };
  }
  it("waits for the first visible frame and drops hidden reactions", () => {
    const { mascot, ready } = setup();
    mascot.setPlaying(true);
    mascot.react("FastOn");
    load();
    expect(ready).not.toHaveBeenCalled();
    expect(renderer.expression.value).toBe(0);
    paint();
    expect(ready).toHaveBeenCalledOnce();
    mascot.setPlaying(false);
    mascot.react("FastOn");
    mascot.setPlaying(true);
    expect(renderer.expression.value).toBe(0);
    mascot.cleanup();
  });
  it("restores the still on load failure and discards pending reactions", () => {
    const { mascot, failed } = setup();
    load();
    mascot.setPlaying(true);
    paint();
    mascot.react("FastOn");
    renderer.options!.onLoadError!({ type: EventType.LoadError });
    expect(failed).toHaveBeenCalledOnce();
    expect(renderer.stopRendering).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    mascot.react("EffortChange");
    expect(renderer.expression.value).toBe(0);
    mascot.cleanup();
  });
  it("ignores late callbacks and releases the Rive instance only once", () => {
    const { mascot, ready, failed } = setup();
    mascot.cleanup();
    load();
    paint();
    renderer.options!.onLoadError!({ type: EventType.LoadError });
    mascot.react("FastOn");
    mascot.setPlaying(true);
    mascot.resize();
    mascot.cleanup();
    expect(ready).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(renderer.cleanup).toHaveBeenCalledOnce();
    expect(renderer.startRendering).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("updates the body and eye bindings without restarting hidden playback", () => {
    const { mascot, canvas } = setup();
    canvas.style.setProperty("--mascot-body", "#12abcd");
    canvas.style.setProperty("--mascot-eyes", "#123456");
    load();
    mascot.syncColors();
    expect(renderer.bodyColor.rgb).toHaveBeenLastCalledWith(18, 171, 205);
    expect(renderer.eyeColor.rgb).toHaveBeenLastCalledWith(18, 52, 86);
    expect(renderer.startRendering).not.toHaveBeenCalled();
    mascot.cleanup();
    renderer.bodyColor.rgb.mockClear();
    mascot.syncColors();
    expect(renderer.bodyColor.rgb).not.toHaveBeenCalled();
  });
});
