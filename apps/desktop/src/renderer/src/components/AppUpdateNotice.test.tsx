import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { UpdateSnapshot, UpdateState } from "../../../shared/app-updates";
import type { OpenOrcApi } from "../../../shared/types";
import { AppUpdateNotice } from "./AppUpdateNotice";
import { isPreviewCovered } from "../lib/browser-preview";

afterEach(cleanup);
function fixture(initial: UpdateState = { phase: "available", version: "0.2.0" }) {
  let listener: (snapshot: UpdateSnapshot) => void = () => {};
  const off = vi.fn();
  const api = {
    getState: vi.fn(async (): Promise<UpdateSnapshot> => ({ state: initial, dismissed: false })),
    onState: vi.fn((callback: typeof listener) => {
      listener = callback;
      return off;
    }),
    download: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    dismiss: vi.fn<OpenOrcApi["updates"]["dismiss"]>(async () => {
      const next = { state: initial, dismissed: true };
      listener(next);
      return next;
    }),
  };
  window.openorc = { updates: api } as unknown as OpenOrcApi;
  const push = (state: UpdateState, dismissed = false) => act(() => listener({ state, dismissed }));
  return { api, push, off };
}

it("shows an automatically discovered update, streams progress, and explicitly requests a restart", async () => {
  const f = fixture({ phase: "idle" });
  render(<AppUpdateNotice />);
  expect(screen.queryByRole("complementary")).toBeNull();
  f.push({ phase: "available", version: "0.2.0" });
  fireEvent.click(await screen.findByRole("button", { name: "Download update" }));
  await waitFor(() => expect(f.api.download).toHaveBeenCalledOnce());
  f.push({ phase: "downloading", version: "0.2.0", percent: 47 });
  expect(screen.getByRole("progressbar").getAttribute("value")).toBe("47");
  expect(screen.queryByRole("button", { name: "Restart to update" })).toBeNull();
  f.push({ phase: "ready", version: "0.2.0" });
  fireEvent.click(screen.getByRole("button", { name: "Restart to update" }));
  await waitFor(() => expect(f.api.install).toHaveBeenCalledOnce());
  f.push({ phase: "ready", version: "0.2.0", error: "A terminal still has a shell running. Use End shell in each terminal, then restart to update." });
  expect(screen.getByRole("alert").textContent).toContain("Use End shell");
});

it("dismisses through main and follows shared dismissal and notification-click events", async () => {
  const f = fixture();
  const view = render(<AppUpdateNotice />);
  fireEvent.click(await screen.findByRole("button", { name: "Later" }));
  await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
  expect(f.api.dismiss).toHaveBeenCalledExactlyOnceWith({ kind: "later", phase: "available", version: "0.2.0" });
  f.push({ phase: "available", version: "0.2.0" });
  expect(screen.getByRole("button", { name: "Download update" })).toBeTruthy();
  view.unmount();
  expect(f.off).toHaveBeenCalledOnce();
});

it("never overwrites a newer event with a slow initial snapshot", async () => {
  const f = fixture();
  let resolve!: (snapshot: UpdateSnapshot) => void;
  f.api.getState.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  render(<AppUpdateNotice />);
  f.push({ phase: "ready", version: "0.2.0" });
  await act(async () => resolve({ state: { phase: "idle" }, dismissed: false }));
  expect(screen.getByRole("button", { name: "Restart to update" })).toBeTruthy();
});

it("offers a retry after download failure and recovery guidance after an install failure", async () => {
  const f = fixture({ phase: "available", version: "0.2.0", error: "Network disconnected" });
  render(<AppUpdateNotice />);
  expect(await screen.findByRole("button", { name: "Retry download" })).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toBe("Network disconnected");
  f.push({ phase: "available", version: "0.2.0", checkError: "Couldn’t check for a newer release: offline" });
  expect(screen.getByRole("alert").textContent).toContain("Couldn’t check for a newer release");
  expect(screen.getByRole("button", { name: "Download update" })).toBeTruthy();
  f.push({ phase: "install-error", message: "Core shutdown could not be confirmed." });
  expect(screen.getByRole("status").textContent).toContain("quit and reopen OpenOrc");
  expect(screen.queryByRole("button", { name: "Restart to update" })).toBeNull();
});

it("shows action failures without losing the notice", async () => {
  const f = fixture();
  f.api.dismiss.mockRejectedValueOnce(new Error("Disk full"));
  render(<AppUpdateNotice />);
  fireEvent.click(await screen.findByRole("button", { name: "Later" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Try again or use the update menu");
  expect(screen.getByRole("complementary", { name: "OpenOrc update" })).toBeTruthy();
});

it.each(["downloading", "install-error"] as const)("can hide %s to keep working in the Preview", async (phase) => {
  const state: UpdateState = phase === "downloading" ? { phase, version: "0.2.0", percent: 47 } : { phase, message: "Core shutdown failed." };
  const f = fixture(state);
  render(<AppUpdateNotice />);
  const hide = await screen.findByRole("button", { name: "Hide" });
  expect(isPreviewCovered()).toBe(true);
  fireEvent.click(hide);
  await waitFor(() => expect(isPreviewCovered()).toBe(false));
  expect(f.api.dismiss).toHaveBeenCalledExactlyOnceWith(phase === "downloading" ? { kind: "hide", phase, version: "0.2.0" } : { kind: "hide", phase });
});
