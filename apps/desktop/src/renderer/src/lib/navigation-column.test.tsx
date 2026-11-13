import { renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const window_ = vi.hoisted(() => ({ trafficLights: true }));
vi.mock("./window", () => ({ useTrafficLights: () => window_.trafficLights }));

import { useLayout } from "./layout";
import { useWindowCorner } from "./navigation-column";

afterEach(() => {
  vi.unstubAllGlobals();
  useLayout.setState({ sidebarOpen: true });
});

const corner = (state: { open: boolean; lights: boolean; narrow?: boolean }) => {
  window_.trafficLights = state.lights;
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: Boolean(state.narrow) && query.includes("max-width"), addEventListener() {}, removeEventListener() {} }));
  useLayout.setState({ sidebarOpen: state.open });
  return renderHook(() => useWindowCorner()).result.current;
};

it("clears the traffic lights only while the first header meets the window's edge: the sidebar hidden, or floating in a narrow window", () => {
  expect(corner({ open: true, lights: true })).toBeNull();
  expect(corner({ open: false, lights: true })).toBe("lights");
  expect(corner({ open: true, lights: true, narrow: true })).toBe("lights");
  expect(corner({ open: false, lights: false })).toBeNull();
  expect(corner({ open: true, lights: false, narrow: true })).toBeNull();
});
