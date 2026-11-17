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

it("steps through what the update brought with Next or the dots, then Done closes the sheet, which settles the steps", () => {
  const { unmount } = render(<WhatsNewSheet />);
  expect(screen.getByRole("img").getAttribute("aria-label")).toBe("An organization's cloud threads on Home, one of them working");
  expect(screen.getByRole("button", { name: "Threads that keep working with your Mac asleep" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByRole("img").getAttribute("aria-label")).toBe("A note from Mara Okafor in a cloud thread, tagging Riley");
  fireEvent.click(screen.getByRole("button", { name: "Chat with your team" }));
  expect(screen.getByRole("img").getAttribute("aria-label")).toBe("A team conversation with messages from Mara Okafor");
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(app.back).toHaveBeenCalledOnce();
  expect(app.close).not.toHaveBeenCalled();
  unmount();
  expect(app.close).toHaveBeenCalledOnce();
});
