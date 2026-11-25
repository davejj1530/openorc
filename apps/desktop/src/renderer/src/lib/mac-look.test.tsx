import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppLook } from "@openorc/protocol";
import { lookOf } from "@openorc/client/theme";

vi.mock("./window-appearance", () => ({ syncWindowAppearance: vi.fn() }));
vi.mock("./color", () => ({ toHex: (color: string) => color }));

/** The core's settings as the renderer reads them: undefined while they load, then the look they hold. */
const core = vi.hoisted(() => ({ look: undefined as AppLook | null | undefined, save: vi.fn() }));
vi.mock("./client", () => ({
  useRpc: () => ({ data: core.look === undefined ? undefined : { look: core.look } }),
  useRpcMutation: () => ({ mutate: core.save }),
}));

import { useBackdrop } from "./backdrop";
import { useLookHandover } from "./mac-look";
import { useTheme } from "./theme";

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  useTheme.setState({ custom: {} });
  useTheme.getState().setPreset("linear");
  useTheme.getState().set("light");
  useBackdrop.getState().change({ style: "off" });
  core.look = undefined;
  core.save.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const onScreen = () => lookOf(useTheme.getState().preset, useTheme.getState().custom, useBackdrop.getState().style);

it("hands the look on screen to the core once its settings show none, and leaves it once they match", () => {
  const handover = renderHook(() => useLookHandover());
  act(() => void vi.advanceTimersByTime(1_000));
  expect(core.save).not.toHaveBeenCalled();
  core.look = null;
  handover.rerender();
  act(() => void vi.advanceTimersByTime(1_000));
  expect(core.save).toHaveBeenCalledExactlyOnceWith({ look: { palette: "linear", colors: {}, backdrop: "off" } });
  core.look = { palette: "linear", colors: {}, backdrop: "off" };
  handover.rerender();
  act(() => void vi.advanceTimersByTime(1_000));
  expect(core.save).toHaveBeenCalledOnce();
});

it("saves where a color picker stops, not each step of the drag, and a palette change at once after", () => {
  core.look = onScreen();
  renderHook(() => useLookHandover());
  for (const value of ["#100000", "#200000", "#300000"]) {
    act(() => void useTheme.getState().setAccent("--accent", value));
    act(() => void vi.advanceTimersByTime(100));
  }
  expect(core.save).not.toHaveBeenCalled();
  act(() => void vi.advanceTimersByTime(1_000));
  expect(core.save).toHaveBeenCalledExactlyOnceWith({ look: { palette: "linear", colors: { light: { "--accent": "#300000" } }, backdrop: "off" } });
  act(() => void useTheme.getState().setPreset("claude"));
  act(() => void vi.advanceTimersByTime(1_000));
  expect(core.save).toHaveBeenLastCalledWith({ look: { palette: "claude", colors: {}, backdrop: "off" } });
});

it("hands over what New thread draws behind itself, and a look saved before it carried one gets it", () => {
  core.look = { palette: "linear", colors: {} };
  renderHook(() => useLookHandover());
  act(() => void vi.advanceTimersByTime(1_000));
  expect(core.save).toHaveBeenLastCalledWith({ look: { palette: "linear", colors: {}, backdrop: "off" } });
  act(() => void useBackdrop.getState().change({ style: "painting" }));
  act(() => void vi.advanceTimersByTime(1_000));
  expect(core.save).toHaveBeenLastCalledWith({ look: { palette: "linear", colors: {}, backdrop: "painting" } });
});

it("keeps System, Light and Dark to this Mac, as a phone keeps its own", () => {
  core.look = onScreen();
  renderHook(() => useLookHandover());
  act(() => void useTheme.getState().set("dark"));
  act(() => void vi.advanceTimersByTime(1_000));
  expect(core.save).not.toHaveBeenCalled();
});
