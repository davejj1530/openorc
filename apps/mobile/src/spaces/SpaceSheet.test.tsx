// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("expo-router", () => ({ router: { back: () => undefined } }));
vi.mock("../client", async () => {
  const { ScratchStore } = await import("../scratch-store");
  return {
    useRpc: () => ({ data: { name: "Riley Chen", image: null } }),
    storage: new ScratchStore({ getString: () => undefined, set: () => undefined, remove: () => undefined }),
    shownMacId: () => "mac-1",
  };
});
vi.mock("./use-spaces", async (original) => ({
  ...(await original<object>()),
  useSpaces: () => {
    const personal = { id: "personal-me", kind: "personal" } as const;
    const birch = { id: "org-birch", kind: "organization", name: "Birch Studio", logo: null, memberId: "m", role: "member", memberCount: 3 } as const;
    return { state: "ready", spaces: [personal, birch], current: personal, access: null, offline: false };
  },
}));

const { SpaceSheet } = await import("./SpaceSheet");
afterEach(cleanup);

it("calls the person's own space OpenOrc, as Home's bar does, with their name under it, then the organizations", () => {
  render(<SpaceSheet />);
  expect(screen.getAllByRole("radio").map((row) => row.getAttribute("aria-label"))).toEqual(["OpenOrc", "Birch Studio"]);
  expect(screen.getByText("Riley Chen")).toBeTruthy();
  expect(screen.queryByText("Personal")).toBeNull();
  expect(screen.getByText("3 people")).toBeTruthy();
});
