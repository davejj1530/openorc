// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

const demo = vi.hoisted(() => ({ shown: 0 }));
vi.mock("expo-router", () => ({ Link: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("../client", async () => {
  const { ScratchStore } = await import("../scratch-store");
  return { storage: new ScratchStore({ getString: () => undefined, set: () => undefined, remove: () => undefined }), showDemo: () => void demo.shown++ };
});

const { Unpaired } = await import("./Unpaired");

afterEach(cleanup);

it("asks for the Mac's code, with one quiet way back into the demo under it", () => {
  render(<Unpaired state={{ kind: "unpaired", lost: null }} />);
  expect(screen.getByText("Pair with your Mac").getAttribute("role")).toBe("header");
  const ways = screen.getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent);
  expect(ways.slice(-2)).toEqual(["Scan code", "Try the demo"]);
  screen.getByRole("button", { name: "Try the demo" }).click();
  expect(demo.shown).toBe(1);
});

it("says why the last Mac went when it removed this iPhone", () => {
  render(<Unpaired state={{ kind: "unpaired", lost: { why: "removed", macName: "Studio" } }} />);
  expect(screen.getByText("Studio removed this iPhone")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Try the demo" })).toBeTruthy();
});
