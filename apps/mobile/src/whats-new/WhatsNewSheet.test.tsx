// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WhatsNewSheet } from "./WhatsNewSheet";

const app = vi.hoisted(() => ({ back: vi.fn(), close: vi.fn() }));
vi.mock("expo-router", () => ({ router: { back: app.back } }));
vi.mock("react-native-keyboard-controller", () => ({ useKeyboardState: () => false }));
vi.mock("../client", () => ({ whatsNew: { take: () => false, close: app.close } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("steps through what the update brought with Next, then Done closes the sheet, which settles the steps", () => {
  const { unmount } = render(<WhatsNewSheet />);
  expect(screen.getByLabelText("Step 1 of 3")).toBeTruthy();
  expect(screen.getAllByRole("img").map((image) => image.getAttribute("aria-label"))).toEqual([
    "An organization's cloud threads on Home, one of them working",
    "A note from Mara Okafor in a cloud thread, tagging Riley",
    "A team conversation with messages from Mara Okafor",
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByLabelText("Step 3 of 3")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(app.back).toHaveBeenCalledOnce();
  expect(app.close).not.toHaveBeenCalled();
  unmount();
  expect(app.close).toHaveBeenCalledOnce();
});
