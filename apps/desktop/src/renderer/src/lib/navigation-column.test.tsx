import { renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const window_ = vi.hoisted(() => ({ trafficLights: true }));
vi.mock("./window", () => ({ useTrafficLights: () => window_.trafficLights }));

import { useLayout } from "./layout";
import { useWindowCorner } from "./navigation-column";
import { useRouter } from "./router";

afterEach(() => {
  vi.unstubAllGlobals();
  useLayout.setState({ sidebarOpen: true });
  useRouter.setState({ route: { view: "newthread" } });
});

const corner = (state: { open: boolean; lights: boolean; settings?: boolean; narrow?: boolean }) => {
  window_.trafficLights = state.lights;
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: Boolean(state.narrow) && query.includes("max-width"), addEventListener() {}, removeEventListener() {} }));
  useLayout.setState({ sidebarOpen: state.open });
  useRouter.setState({ route: state.settings ? { view: "settings" } : { view: "tasks" } });
  return renderHook(() => useWindowCorner()).result.current;
};

it("leaves the folded rail's corner to the wordmark only when no traffic lights hold it, else to the lights past the rail", () => {
  expect(corner({ open: false, lights: false })).toBe("wordmark");
  expect(corner({ open: false, lights: true })).toBe("rail-lights");
  expect(corner({ open: true, lights: false })).toBeNull();
});

it("clears the traffic lights only when nothing of the navigation shows, in a narrow window; Settings keeps the folded rail", () => {
  expect(corner({ open: false, lights: true, settings: true })).toBe("rail-lights");
  expect(corner({ open: false, lights: false, settings: true })).toBe("wordmark");
  expect(corner({ open: false, lights: true, narrow: true })).toBe("lights");
  expect(corner({ open: false, lights: false, narrow: true })).toBeNull();
});
