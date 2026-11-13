import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { UpdateSnapshot } from "../../../shared/app-updates";
import { RailUpdate } from "./SidebarRailUpdate";

vi.mock("./ui", async (original) => ({ ...(await original<object>()), Tooltip: ({ children }: { children: React.ReactNode }) => children }));

let push: (snapshot: UpdateSnapshot) => void = () => {};
const updates = { getState: vi.fn(), onState: vi.fn(), check: vi.fn(async () => {}), download: vi.fn(async () => {}), install: vi.fn(async () => {}) };

function show(snapshot: UpdateSnapshot) {
  updates.getState.mockResolvedValue(snapshot);
  updates.onState.mockImplementation((listener: (next: UpdateSnapshot) => void) => {
    push = listener;
    return () => {};
  });
  Object.assign(window, { openorc: { updates } });
  return render(<RailUpdate />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("checks for updates while nothing newer is known, says how the check went, and holds still while it runs", async () => {
  show({ state: { phase: "idle" }, dismissed: false });
  fireEvent.click(await screen.findByRole("button", { name: "Check for updates" }));
  await act(async () => {});
  expect(updates.check).toHaveBeenCalledTimes(1);
  act(() => push({ state: { phase: "checking" }, dismissed: false }));
  const checking = screen.getByRole("button", { name: "Checking for updates…" });
  fireEvent.click(checking);
  expect(updates.check).toHaveBeenCalledTimes(1);
  expect(checking.dataset["offer"]).toBeUndefined();
  act(() => push({ state: { phase: "current" }, dismissed: false }));
  fireEvent.click(screen.getByRole("button", { name: "OpenOrc is up to date. Check again" }));
  await act(async () => {});
  act(() => push({ state: { phase: "error", message: "The network is offline." }, dismissed: false }));
  fireEvent.click(screen.getByRole("button", { name: "Couldn’t check for updates: The network is offline. Check again" }));
  await act(async () => {});
  expect(updates.check).toHaveBeenCalledTimes(3);
});

it("offers a new version's download once there is one, dismissed notice or not, marked apart from a check", async () => {
  show({ state: { phase: "current" }, dismissed: false });
  await screen.findByRole("button", { name: "OpenOrc is up to date. Check again" });
  act(() => push({ state: { phase: "available", version: "0.2.0" }, dismissed: true }));
  const download = screen.getByRole("button", { name: "Download OpenOrc 0.2.0" });
  expect(download.dataset["offer"]).toBe("true");
  fireEvent.click(download);
  expect(updates.download).toHaveBeenCalledTimes(1);
});

it("is not shown in a build that can't update itself", async () => {
  show({ state: { phase: "disabled", reason: "Updates come from the app's own installer." }, dismissed: false });
  await act(async () => {});
  expect(screen.queryByRole("button")).toBeNull();
});

it("shows the download's progress, then restarts into the update when it is ready", async () => {
  show({ state: { phase: "downloading", version: "0.2.0", percent: 40 }, dismissed: false });
  const downloading = await screen.findByRole("button", { name: "Downloading OpenOrc 0.2.0 · 40%" });
  fireEvent.click(downloading);
  expect([updates.download.mock.calls.length, updates.install.mock.calls.length]).toEqual([0, 0]);
  act(() => push({ state: { phase: "ready", version: "0.2.0" }, dismissed: false }));
  fireEvent.click(screen.getByRole("button", { name: "Restart to update to OpenOrc 0.2.0" }));
  expect(updates.install).toHaveBeenCalledTimes(1);
});
