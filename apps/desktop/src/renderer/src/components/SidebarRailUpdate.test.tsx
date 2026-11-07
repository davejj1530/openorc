import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { UpdateSnapshot } from "../../../shared/app-updates";
import { RailUpdate } from "./SidebarRailUpdate";

vi.mock("./ui", async (original) => ({ ...(await original<object>()), Tooltip: ({ children }: { children: React.ReactNode }) => children }));

let push: (snapshot: UpdateSnapshot) => void = () => {};
const updates = { getState: vi.fn(), onState: vi.fn(), download: vi.fn(async () => {}), install: vi.fn(async () => {}) };

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

it("is not shown while OpenOrc is current, and offers a new version's download once there is one, dismissed notice or not", async () => {
  show({ state: { phase: "current" }, dismissed: false });
  await act(async () => {});
  expect(screen.queryByRole("button")).toBeNull();
  act(() => push({ state: { phase: "available", version: "0.2.0" }, dismissed: true }));
  fireEvent.click(screen.getByRole("button", { name: "Download OpenOrc 0.2.0" }));
  expect(updates.download).toHaveBeenCalledTimes(1);
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
