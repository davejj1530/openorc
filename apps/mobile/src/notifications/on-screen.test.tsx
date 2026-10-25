// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";

const center = vi.hoisted(() => ({ cleared: [] as string[] }));
vi.mock("expo-router", () => ({ useFocusEffect: (effect: () => () => void) => useEffect(effect, [effect]) }));
vi.mock("./native", () => ({
  notificationCenter: {
    delivered: async () => [
      { id: "mine", data: { macId: "studio", id: "n1", kind: "finished", threadId: "t1" } },
      { id: "other", data: { macId: "studio", id: "n2", kind: "finished", threadId: "t2" } },
    ],
    dismiss: async (id: string) => void center.cleared.push(id),
  },
}));

const { threadOnScreen, useThreadOnScreen } = await import("./on-screen");

afterEach(cleanup);

it("records the thread on screen while it has focus and clears what its alerts said", async () => {
  const screen = renderHook(() => useThreadOnScreen("studio", "t1"));
  expect(threadOnScreen()).toBe("t1");
  await vi.waitFor(() => expect(center.cleared).toEqual(["mine"]));
  screen.unmount();
  expect(threadOnScreen()).toBeNull();
});
