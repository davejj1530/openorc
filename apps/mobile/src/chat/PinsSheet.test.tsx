// @vitest-environment jsdom
import type { TeamChatPins } from "@openorc/protocol";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatPinsSheet } from "./PinsSheet";
import { useAskedJump, useRevealScroll } from "./reveal";

const chat = vi.hoisted(() => ({ pins: undefined as TeamChatPins | undefined, back: vi.fn() }));
vi.mock("expo-router", () => ({ router: { back: chat.back }, useLocalSearchParams: () => ({ id: "c-launch" }) }));
vi.mock("../client", () => ({ teamChat: { usePins: () => ({ data: chat.pins, error: null }) } }));
vi.mock("./lease", () => ({ useChatLease: () => ({ accountId: "u-riley", spaceId: "org-birch", generation: 1, reach: "live", current: () => true }) }));
vi.mock("../ui/SheetHeader", () => ({ SheetHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));
vi.mock("../ui/sheet-bottom", () => ({ useSheetBottom: () => 16 }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const MARA = { id: "u-mara", name: "Mara Okafor", image: null };
const message = (id: string, seq: number, body: string) =>
  ({ id, seq, channelId: "c-launch", body, files: [], actor: { kind: "person", person: MARA } }) as unknown as TeamChatPins["pins"][number]["message"];

it("lists the conversation's pins with who pinned them, and a pin asks the open conversation to show its message", () => {
  chat.pins = { pins: [{ message: message("m4", 4, "The annual toggle defaults to monthly."), pinnedBy: { id: "u-riley", name: "Riley Chen", image: null }, pinnedAt: new Date().toISOString() }] };
  render(<ChatPinsSheet />);
  const asked = renderHook(() => useAskedJump("c-launch"));
  const pin = screen.getByRole("button");
  expect(pin.getAttribute("aria-label")).toMatch(/^Mara Okafor: The annual toggle defaults to monthly\., Pinned by you · /);
  fireEvent.click(pin);
  expect(chat.back).toHaveBeenCalledOnce();
  expect(asked.result.current).toMatchObject({ id: "m4", seq: 4 });
  // The conversation scrolls to it once its row reports where it sits, and the request is then done.
  const scrollTo = vi.fn();
  const list = { current: { scrollTo } } as never;
  const layout = renderHook(() => useRevealScroll(list, asked.result.current, vi.fn()));
  act(() => layout.result.current("m4", 500));
  expect(scrollTo).toHaveBeenCalledWith({ y: 404, animated: false });
  asked.rerender();
  expect(asked.result.current).toBeNull();
  cleanup();
  chat.pins = { pins: [] };
  render(<ChatPinsSheet />);
  expect(screen.getByText("No pinned messages")).toBeTruthy();
});
