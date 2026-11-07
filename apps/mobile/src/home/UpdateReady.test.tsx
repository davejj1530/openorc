// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { AppState } from "react-native";
import { afterEach, expect, it, vi } from "vitest";

const updates = vi.hoisted(() => ({
  isEnabled: true,
  pending: false,
  reloadAsync: vi.fn(async () => undefined),
  checkForUpdateAsync: vi.fn(async () => ({ isAvailable: true })),
  fetchUpdateAsync: vi.fn(async () => ({})),
}));
vi.mock("expo-updates", () => ({
  get isEnabled() {
    return updates.isEnabled;
  },
  useUpdates: () => ({ isUpdatePending: updates.pending }),
  reloadAsync: updates.reloadAsync,
  checkForUpdateAsync: updates.checkForUpdateAsync,
  fetchUpdateAsync: updates.fetchUpdateAsync,
}));

const { UpdateReady } = await import("./UpdateReady");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.assign(updates, { isEnabled: true, pending: false });
  for (const call of [updates.reloadAsync, updates.checkForUpdateAsync, updates.fetchUpdateAsync]) call.mockClear();
});

it("shows nothing until a new version has downloaded, then restarts into it when asked", () => {
  const view = render(<UpdateReady />);
  expect(screen.queryByRole("button")).toBeNull();
  updates.pending = true;
  view.rerender(<UpdateReady />);
  expect(screen.getByText("New version ready")).toBeTruthy();
  act(() => screen.getByRole("button", { name: "Restart to update" }).click());
  expect(updates.reloadAsync).toHaveBeenCalledTimes(1);
});

it("shows nothing in a build that takes no updates, as in development", () => {
  Object.assign(updates, { isEnabled: false, pending: true });
  render(<UpdateReady />);
  expect(screen.queryByRole("button")).toBeNull();
});

it("looks for a new version when the app comes back to the front, at most every half hour", async () => {
  let changed: (state: string) => void = () => undefined;
  vi.spyOn(AppState, "addEventListener").mockImplementation(((_: string, listener: (state: string) => void) => ((changed = listener), { remove: () => undefined })) as never);
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  render(<UpdateReady />);
  changed("active");
  expect(updates.checkForUpdateAsync).not.toHaveBeenCalled();
  now += 31 * 60_000;
  changed("background");
  changed("active");
  changed("active");
  expect(updates.checkForUpdateAsync).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(updates.fetchUpdateAsync).toHaveBeenCalledTimes(1));
});
