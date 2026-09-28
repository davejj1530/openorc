import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenOrcApi, UpdateSettings } from "../../../shared/types";
import { queryClient } from "../lib/query";
import { UpdateSettingsSection } from "./settings-updates";

function show(saved: UpdateSettings, save = vi.fn(async (on: boolean) => ({ ...saved, automaticChecks: on }))) {
  window.openorc = { platform: "darwin", updates: { settings: vi.fn(async () => saved), setAutomaticChecks: save } } as unknown as OpenOrcApi;
  render(
    <QueryClientProvider client={queryClient}>
      <UpdateSettingsSection />
    </QueryClientProvider>,
  );
  return save;
}
afterEach(() => {
  cleanup();
  queryClient.clear();
});

it("turns automatic update checks off in the main process", async () => {
  const save = show({ automaticChecks: true, unavailable: null });
  const toggle = (await screen.findByRole("switch", { name: /Check for updates automatically/ })) as HTMLInputElement;
  await waitFor(() => expect(toggle.disabled).toBe(false));
  expect(toggle.checked).toBe(true);
  expect(screen.getByText(/use Check for updates in the OpenOrc menu/)).toBeTruthy();
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.checked).toBe(false));
  expect(save).toHaveBeenCalledWith(false);
});

it("says why a build cannot update and keeps the previous setting when saving fails", async () => {
  show(
    { automaticChecks: false, unavailable: "Development builds do not contact the update service." },
    vi.fn(async () => Promise.reject(new Error("disk full"))),
  );
  const toggle = (await screen.findByRole("switch", { name: /Check for updates automatically/ })) as HTMLInputElement;
  await waitFor(() => expect(toggle.disabled).toBe(false));
  expect(screen.getByText("Development builds do not contact the update service.")).toBeTruthy();
  fireEvent.click(toggle);
  expect((await screen.findByRole("alert")).textContent).toBe("Could not save. Your previous setting is still active.");
  expect(toggle.checked).toBe(false);
});
