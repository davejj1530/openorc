import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { UpdateSnapshot } from "../../../shared/app-updates";
import { SidebarUpdate } from "./SidebarUpdate";

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
  return render(<SidebarUpdate />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("shows nothing while no update waits: before a check, during one, after one and when it failed", async () => {
  show({ state: { phase: "idle" }, dismissed: false });
  await act(async () => {});
  expect(screen.queryByRole("button")).toBeNull();
  for (const state of [{ phase: "checking" }, { phase: "current" }, { phase: "error", message: "The network is offline." }] as const) {
    act(() => push({ state, dismissed: false }));
    expect(screen.queryByRole("button")).toBeNull();
  }
});

it("offers a new version's download once there is one, dismissed notice or not, with its dot", async () => {
  show({ state: { phase: "current" }, dismissed: false });
  await act(async () => {});
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
