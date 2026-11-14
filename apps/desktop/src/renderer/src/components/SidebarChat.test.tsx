import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { TeamChatRow } from "@openorc/client";
import { afterEach, expect, it, vi } from "vitest";
import { SidebarChat } from "./SidebarChat";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const person = (id: string, name: string): TeamChatRow => ({ kind: "person", id, title: name, person: { id, name, image: null }, conversation: null });
const first = person("first", "Alex Morgan");
const second = person("second", "Sam Lee");
const props = { self: "self", selected: null, opening: null, error: null, onOpen: vi.fn(), onRetry: vi.fn() };

it("keeps rows under a resting pointer until the shared settling delay ends", () => {
  vi.useFakeTimers();
  const view = render(<SidebarChat {...props} rows={[first, second]} />);
  const list = view.getByRole("region", { name: "Chat" });
  const names = () => [...view.container.querySelectorAll(".sidebar-chat-title")].map((row) => row.textContent);
  fireEvent.pointerEnter(list);
  view.rerender(<SidebarChat {...props} rows={[second, first]} />);
  expect(names()).toEqual(["Alex Morgan", "Sam Lee"]);
  fireEvent.pointerLeave(list);
  act(() => {
    vi.advanceTimersByTime(1499);
  });
  expect(names()).toEqual(["Alex Morgan", "Sam Lee"]);
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(names()).toEqual(["Sam Lee", "Alex Morgan"]);
});

it("holds keyboard order but immediately drops removed people and updates current identities", () => {
  const view = render(<SidebarChat {...props} rows={[first, second]} />);
  const row = view.getByRole("button", { name: /^Alex Morgan$/ });
  act(() => row.focus());
  view.rerender(<SidebarChat {...props} rows={[second, person("first", "Alex Miller")]} />);
  expect([...view.container.querySelectorAll(".sidebar-chat-title")].map((node) => node.textContent)).toEqual(["Alex Miller", "Sam Lee"]);
  view.rerender(<SidebarChat {...props} rows={[second]} />);
  expect(view.queryByRole("button", { name: /^Alex Miller$/ })).toBeNull();
  expect(view.getByRole("button", { name: /^Sam Lee$/ })).toBeTruthy();
});
